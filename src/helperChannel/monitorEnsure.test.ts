// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D2 (decision of 2026-10-03): the operation `monitorEnsure` of the worker: the ensure of the Session Monitor
// container (RemoteSessionMonitor over engineMonitor) with the worker's own helper image and socket and the script of its
// bundle, against a small engine in memory.
import { describe, expect, it } from 'vitest';
import { bundleHash, encodeBundle } from '../core/loader/pipeLoader';
import { parseMonitorEnsureParams, parseMonitorEnsureValue } from '../core/helperChannel/protocol';
import { LABEL_MONITOR_CREATE, LABEL_SESSION_MONITOR, PERMANENT_LOCAL_LABEL_PART, PERMANENT_REMOTE_LABEL_PART, remoteMonitorLabelValue, vscodeStoreLabelPart } from '../core/remoteMonitor/protocol';
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
  };
  return { context, controller, lines };
}

function engineWith(state: { existing?: unknown; created?: MonitorCreated; tagFails?: boolean }) {
  const specs: MonitorRunSpec[] = [];
  const inputs: string[] = [];
  const removed: string[] = [];
  const tagged: string[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    tagImage: async (image, reference) => {
      if (state.tagFails) throw new Error('no such image');
      tagged.push(`${image} ${reference}`);
    },
    inspect: async () => state.existing,
    createAttached: async (spec, options) => {
      specs.push(spec);
      inputs.push(options.input);
      return state.created ?? { kind: 'ready' };
    },
    containerIds: async () => ['c0ffee'.padEnd(64, '0')],
    removeContainer: async (id) => void removed.push(id),
  };
  return { engine, specs, inputs, removed, tagged };
}

describe('the ensure of the Session Monitor in the worker (plan step 11D2)', () => {
  it('creates a missing monitor with the worker\'s helper image, its socket and the script of its bundle', async () => {
    const { engine, specs, inputs, tagged } = engineWith({});
    const value = await monitorEnsureOperation(() => engine, async () => OWN, () => SCRIPT)({ images: IMAGES }, contextOf().context);
    expect(parseMonitorEnsureValue(value)).toEqual({ outcome: 'created' });
    expect(specs).toHaveLength(1);
    const [spec] = specs;
    // The label names the tag. Plan step 11D3 (option B of 2026-10-03): the container runs from the monitor tag of the
    // pinned image (before: from its ID), tagged first, and the create checks that ID.
    expect(tagged).toEqual([`${OWN.image.id} devenv-monitor:0123456789ab`]);
    expect(spec.image).toBe('devenv-monitor:0123456789ab');
    expect(spec.imageId).toBe(OWN.image.id);
    expect(spec.labels[LABEL_SESSION_MONITOR]).toBe(remoteMonitorLabelValue(SCRIPT, OWN.image.tag, []));
    expect(spec.labels[LABEL_MONITOR_CREATE]).toMatch(/^[0-9a-f-]{36}$/);
    expect(spec.mounts).toEqual({ socket: OWN.socket, volume: 'devenv-session-monitor', volumeTarget: '/state' });
    // Plan step 11H2 (D1, decision of 2026-10-09): changed expectation, the monitor always has the default network (its
    // background run reaches the update service of VS Code); was `none` without image maintenance.
    expect(spec.network).toBe('default');
    expect(spec.command.slice(-2)).toEqual([bundleHash(SCRIPT), 'startMonitor']);
    expect(inputs).toEqual([encodeBundle(SCRIPT)]);
  });

  it('with image maintenance: its part of the label, the default network and the settings of this computer', async () => {
    const { engine, specs } = engineWith({});
    const images = { prefixes: ['ghcr.io/acme/base'], schedule: '0 5 * * 1-5', timeZone: 'Europe/Vienna' };
    await monitorEnsureOperation(() => engine, async () => OWN, () => SCRIPT)({ images }, contextOf().context);
    // Plan step 11H2 (D1, decision of 2026-10-09): changed expectation, the image maintenance is no part of the label any
    // more (the monitor always has its network); the label holds the mode, here one that ends when idle (was the part
    // `image-maintenance`).
    expect(specs[0].labels[LABEL_SESSION_MONITOR]).toBe(remoteMonitorLabelValue(SCRIPT, OWN.image.tag, []));
    expect(specs[0].network).toBe('default');
    expect(specs[0].env).toEqual({ DEVENV_IMAGE_PREFIXES: JSON.stringify(images.prefixes), DEVENV_IMAGE_SCHEDULE: images.schedule, DEVENV_IMAGE_TZ: images.timeZone });
  });

  // Plan step 11H2 (D1 and the user's decision "unless-stopped" of 2026-10-09): a permanent monitor (MonitorSettings.permanent)
  // has its part of the label and the restart policy `unless-stopped`; the worker's store is mounted read-write at /vscode.
  it('a permanent monitor with the store of the worker: its label part, unless-stopped, the store mount and its name (plan step 11H2)', async () => {
    const { engine, specs } = engineWith({});
    const own: OwnHelper = { ...OWN, vscodeStore: 'devenv-vscode' };
    await monitorEnsureOperation(() => engine, async () => own, () => SCRIPT)({ images: { ...IMAGES, permanent: true } }, contextOf().context);
    // Review round 1 of 11H2 (A-L2, A-L6): changed expectation, the part says why it is permanent (here: no `remote`, so
    // `permanent-local`; was `permanent`), and the label names the store that it mounts.
    expect(specs[0].labels[LABEL_SESSION_MONITOR]).toBe(remoteMonitorLabelValue(SCRIPT, OWN.image.tag, [PERMANENT_LOCAL_LABEL_PART, vscodeStoreLabelPart('devenv-vscode')]));
    expect(specs[0].restartPolicy).toBe('unless-stopped');
    expect(specs[0].mounts).toEqual({ socket: OWN.socket, volume: 'devenv-session-monitor', volumeTarget: '/state', store: { volume: 'devenv-vscode', target: '/vscode' } });
    expect(specs[0].env).toEqual({ DEVENV_IMAGE_SCHEDULE: IMAGES.schedule, DEVENV_IMAGE_TZ: IMAGES.timeZone, DEVENV_MONITOR_PERMANENT: '1', DEVENV_VSCODE_STORE: 'devenv-vscode' });
    // One that ends when idle: `on-failure`, no part, no variable of the mode.
    const idle = engineWith({});
    await monitorEnsureOperation(() => idle.engine, async () => own, () => SCRIPT)({ images: { ...IMAGES, permanent: false } }, contextOf().context);
    // Review round 1 of 11H2 (A-L6): changed expectation, the label names the store (was no part).
    expect(idle.specs[0].labels[LABEL_SESSION_MONITOR]).toBe(remoteMonitorLabelValue(SCRIPT, OWN.image.tag, [vscodeStoreLabelPart('devenv-vscode')]));
    expect(idle.specs[0].restartPolicy).toBe('on-failure');
    expect(idle.specs[0].env).not.toHaveProperty('DEVENV_MONITOR_PERMANENT');
  });

  // Review round 1 of 11H2 (A-L2): a monitor that is permanent because this computer reaches the engine as a remote one.
  it('a permanent monitor of a remote engine: the part `permanent-remote` (review round 1 of 11H2)', async () => {
    const { engine, specs } = engineWith({});
    await monitorEnsureOperation(() => engine, async () => OWN, () => SCRIPT)({ images: { ...IMAGES, permanent: true, remote: true } }, contextOf().context);
    expect(specs[0].labels[LABEL_SESSION_MONITOR]).toBe(remoteMonitorLabelValue(SCRIPT, OWN.image.tag, [PERMANENT_REMOTE_LABEL_PART]));
    expect(specs[0].restartPolicy).toBe('unless-stopped');
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

describe('the image of the monitor container (plan step 11D3, option B of 2026-10-03)', () => {
  it('a tag that fails: the monitor runs from the image ID, with a warning', async () => {
    const { engine, specs } = engineWith({ tagFails: true });
    const { context, lines } = contextOf();
    expect(parseMonitorEnsureValue(await monitorEnsureOperation(() => engine, async () => OWN, () => SCRIPT)({ images: IMAGES }, context))).toEqual({ outcome: 'created' });
    expect(specs[0].image).toBe(OWN.image.id);
    expect(specs[0].imageId).toBeUndefined();
    expect(lines.some((line) => line.includes('could not be tagged as devenv-monitor:0123456789ab') && line.includes('no such image'))).toBe(true);
  });

  it('a worker whose tag is no helper tag: the image ID, nothing tagged', async () => {
    const { engine, specs, tagged } = engineWith({});
    const own: OwnHelper = { ...OWN, image: { ...OWN.image, tag: 'something:else' } };
    await monitorEnsureOperation(() => engine, async () => own, () => SCRIPT)({ images: IMAGES }, contextOf().context);
    expect(tagged).toEqual([]);
    expect(specs[0].image).toBe(OWN.image.id);
    expect(specs[0].imageId).toBeUndefined();
  });

  it('a worker without an image ID: its tag, nothing tagged', async () => {
    const { engine, specs, tagged } = engineWith({});
    const own: OwnHelper = { ...OWN, image: { tag: OWN.image.tag } };
    await monitorEnsureOperation(() => engine, async () => own, () => SCRIPT)({ images: IMAGES }, contextOf().context);
    expect(tagged).toEqual([]);
    expect(specs[0].image).toBe(OWN.image.tag);
    expect(specs[0].imageId).toBeUndefined();
  });

  it('a cancel during the tag cancels the operation; nothing is created', async () => {
    const { context, controller } = contextOf();
    const { engine, specs } = engineWith({});
    engine.tagImage = async (_image, _reference, signal) =>
      new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    const running = monitorEnsureOperation(() => engine, async () => OWN, () => SCRIPT)({ images: IMAGES }, context);
    setTimeout(() => controller.abort(), 20);
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    expect(specs).toEqual([]);
  });
});
