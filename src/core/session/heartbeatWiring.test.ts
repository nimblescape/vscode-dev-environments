// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { DockerTarget } from '../docker/dockerHost';
import type { HelperImageUse } from '../helper/helperImage';
import { HELPER_PREBUILD_TIMEOUT_MS } from '../helper/helperPrebuild';
import type { PresentImageOptions } from '../helper/workspaceHelper';
import { HeartbeatPreparation } from './heartbeatPreparation';
import { heartbeatWiring } from './heartbeatWiring';

const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const LOCAL: DockerTarget = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock', context: 'default' };
const REMOTE: DockerTarget = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box', context: 'devenv-remote-11111111' };
const IMAGE: HelperImageUse = { tag: 'devenv-helper:0123456789ab', id: 'sha256:1111' };

/** The wiring with a helper whose tag is missing and whose builds fail (or succeed), with the targets of its builds. */
function setup() {
  const now = { value: T0 };
  const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => now.value });
  const state = { buildFails: true, operation: undefined as DockerTarget | undefined };
  const builds: DockerTarget[] = [];
  const disposables: { dispose(): void }[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let current: DockerTarget | undefined;
  const wiring = heartbeatWiring({
    preparation,
    helper: {
      ensureImagePresent: async (options: PresentImageOptions): Promise<HelperImageUse> => {
        signals.push(options.signal);
        options.onBuild?.('create');
        builds.push(current as DockerTarget);
        if (state.buildFails) throw new Error('docker build failed: no space left on device');
        return IMAGE;
      },
      presentImage: async (): Promise<HelperImageUse | undefined> => undefined,
    },
    inTarget: async (target, fn) => {
      current = target;
      return fn();
    },
    onOutput: () => {},
    operationTarget: () => state.operation,
    subscriptions: { push: (disposable) => disposables.push(disposable) },
  });
  /** A failed build of a heartbeat's worker on `target`: its engine waits. */
  const failOn = async (target: DockerTarget): Promise<void> => {
    await expect(preparation.scope(() => wiring.prepareWorker(target, undefined))).rejects.toThrow('no space left');
  };
  /** Whether a heartbeat's worker on `target` is refused (within the wait) rather than built. */
  const waits = async (target: DockerTarget): Promise<boolean> => {
    const before = builds.length;
    await preparation.scope(() => wiring.prepareWorker(target, undefined)).catch(() => undefined);
    return builds.length === before;
  };
  return { now, preparation, state, builds, disposables, signals, wiring, failOn, waits };
}

// Review round 5 of PR #85 (B-R5-1): the wiring of the heartbeats' helper image that extension.ts had inline.
describe('heartbeatWiring (review round 5 of PR #85, B-R5-1)', () => {
  it('a build of the helper image by an operation on a known engine ends the wait of that engine only (E01, E02)', async () => {
    const { preparation, state, wiring, failOn, waits } = setup();
    await failOn(LOCAL);
    await failOn(REMOTE);
    state.operation = REMOTE;
    wiring.imageBuilt();
    expect(await waits(REMOTE)).toBe(false);
    expect(await waits(LOCAL)).toBe(true);
    preparation.dispose();
  });

  it('a build on an engine that is not known ends every wait (E01, E03)', async () => {
    const { preparation, wiring, failOn, waits } = setup();
    await failOn(LOCAL);
    await failOn(REMOTE);
    expect(await waits(LOCAL)).toBe(true);
    expect(await waits(REMOTE)).toBe(true);
    wiring.imageBuilt();
    expect(await waits(LOCAL)).toBe(false);
    expect(await waits(REMOTE)).toBe(false);
    preparation.dispose();
  });

  it("the worker's preparation goes through the preparation: in a heartbeat, with its long signal and its wait (E04)", async () => {
    const { preparation, builds, signals, wiring, failOn } = setup();
    const caller = new AbortController();
    await expect(preparation.scope(() => wiring.prepareWorker(LOCAL, caller.signal))).rejects.toThrow('no space left');
    expect(signals[0]).toBeDefined();
    expect(signals[0]).not.toBe(caller.signal);
    await expect(preparation.scope(() => wiring.prepareWorker(LOCAL, undefined))).rejects.toThrow('prepared again in 60 seconds');
    expect(builds).toEqual([LOCAL]);
    await failOn(REMOTE);
    expect(builds).toEqual([LOCAL, REMOTE]);
    preparation.dispose();
  });

  it('the repair goes through the preparation in the scope of a heartbeat, on its engine, then starts the monitor with the image (E05)', async () => {
    const { preparation, state, builds, signals, wiring } = setup();
    const started: [HelperImageUse, DockerTarget, AbortSignal][] = [];
    const repair = wiring.repair(async (image, target, signal) => {
      started.push([image, target, signal]);
    });
    const caller = new AbortController();
    // Outside the scope of a heartbeat too: the repair is always one of a heartbeat (the long signal, the wait).
    await expect(repair(REMOTE, caller.signal)).rejects.toThrow('no space left');
    expect(signals[0]).not.toBe(caller.signal);
    await expect(repair(REMOTE, caller.signal)).rejects.toThrow('prepared again in 60 seconds');
    expect(builds).toEqual([REMOTE]);
    expect(started).toEqual([]);
    state.buildFails = false;
    await repair(LOCAL, caller.signal);
    expect(builds).toEqual([REMOTE, LOCAL]);
    expect(started).toEqual([[IMAGE, LOCAL, caller.signal]]);
    preparation.dispose();
  });

  it('registers the disposal of the preparation with the window: it aborts the running preparations (E06)', async () => {
    const { preparation, disposables, wiring } = setup();
    expect(disposables).toHaveLength(1);
    let got: AbortSignal | undefined;
    const running = preparation.scope(() =>
      preparation.prepare(
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            got = signal;
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
        undefined,
        LOCAL,
      ),
    );
    running.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(got?.aborted).toBe(false);
    for (const disposable of disposables) disposable.dispose();
    expect(got?.aborted).toBe(true);
    await expect(running).rejects.toBeDefined();
    expect(wiring.preparation).toBe(preparation);
  });

  it('extension.ts uses the wiring: no preparation, onImageBuilt, prepare or repair of the heartbeats of its own', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'vscode', 'extension.ts'), 'utf8');
    expect(source).toContain('heartbeatWiring({');
    expect(source).toContain('subscriptions: context.subscriptions,');
    expect(source).toContain('operationTarget: operationDockerTarget,');
    expect(source).toContain('heartbeats.imageBuilt();');
    expect(source).toContain('await heartbeats.prepareWorker(target, signal);');
    expect(source).toContain('const repairSessionMonitor = heartbeats.repair(');
    expect(source).toContain('repair: repairSessionMonitor,');
    expect(source).not.toContain('new HeartbeatPreparation(');
    expect(source).not.toContain('heartbeatHelperImage(');
    expect(source).not.toMatch(/\.clearAll\(\)/);
  });
});
