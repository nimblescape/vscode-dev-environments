// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { DockerTarget } from '../docker/dockerHost';
import type { HelperImageUse } from '../helper/helperImage';
import { HELPER_PREBUILD_TIMEOUT_MS } from '../helper/helperPrebuild';
import type { PresentImageOptions } from '../helper/helperImages';
import { isAbortError } from '../ports';
import { HeartbeatPreparation } from './heartbeatPreparation';
import { heartbeatWiring } from './heartbeatWiring';

/** Lets the promises that are ready run (no timers). */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const LOCAL: DockerTarget = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock', context: 'default' };
const REMOTE: DockerTarget = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box', context: 'devenv-remote-11111111' };
const OTHER: DockerTarget = { kind: 'remote', host: 'other-box', endpoint: 'ssh://other-box', context: 'devenv-remote-22222222' };
const IMAGE: HelperImageUse = { tag: 'devenv-helper:0123456789ab', id: 'sha256:1111' };

/**
 * PR H (decision of 2026-10-09): the maintaining ensure, which only the preparation for an operation `open` calls; the
 * preparations of the heartbeats and repairs of these tests must never call it.
 */
const unexpectedEnsureImageUse = async (): Promise<HelperImageUse> => {
  throw new Error('ensureImageUse is only for the preparation of an open');
};

/** The wiring with a helper whose tag is missing and whose builds fail (or succeed), with the targets of its builds. */
function setup() {
  const now = { value: T0 };
  const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => now.value });
  // Review round 6 of PR #85 (B-R6-2): `hang` makes a build that never ends.
  const state = { buildFails: true, hang: false, operation: undefined as DockerTarget | undefined };
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
        if (state.hang) return new Promise<HelperImageUse>(() => {});
        if (state.buildFails) throw new Error('docker build failed: no space left on device');
        return IMAGE;
      },
      ensureImageUse: unexpectedEnsureImageUse,
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
    const { preparation, state, builds, signals, wiring, failOn } = setup();
    const caller = new AbortController();
    await expect(preparation.scope(() => wiring.prepareWorker(LOCAL, caller.signal))).rejects.toThrow('no space left');
    expect(signals[0]).toBeDefined();
    expect(signals[0]).not.toBe(caller.signal);
    await expect(preparation.scope(() => wiring.prepareWorker(LOCAL, undefined))).rejects.toThrow('prepared again in 60 seconds');
    expect(builds).toEqual([LOCAL]);
    await failOn(REMOTE);
    expect(builds).toEqual([LOCAL, REMOTE]);
    // Review round 6 of PR #85 (B-R6-2): the heartbeat's own signal ends only its wait; the build goes on with the long
    // signal.
    state.hang = true;
    const deadline = new AbortController();
    const hanging = preparation.scope(() => wiring.prepareWorker(OTHER, deadline.signal));
    let gaveUp = false;
    hanging.catch(() => (gaveUp = true));
    await settle();
    expect(builds).toEqual([LOCAL, REMOTE, OTHER]);
    deadline.abort();
    await settle();
    expect(gaveUp).toBe(true);
    await expect(hanging).rejects.toSatisfy(isAbortError);
    expect(signals[2]).not.toBe(deadline.signal);
    expect(signals[2]?.aborted).toBe(false);
    preparation.dispose();
  });

  // Plan step 11D2: changed, the repair is the worker's operation `monitorEnsure` on its engine; its worker is prepared as
  // the flow prepares it (prepareWorker, here in the fake ensure), in the scope of the heartbeat. Before, the repair built
  // the image itself and started the monitor with it.
  it('the repair runs the ensure on its engine in the scope of a heartbeat, whose worker goes through the preparation (E05)', async () => {
    const { preparation, state, builds, signals, wiring } = setup();
    const started: [DockerTarget, AbortSignal][] = [];
    const repair = wiring.repair(async (target, signal) => {
      await wiring.prepareWorker(target, signal);
      started.push([target, signal]);
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
    expect(started).toEqual([[LOCAL, caller.signal]]);
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
    // Changed expectation, review round 1 of PR #87, B-R1-7 (a): the preparation is disposed after the release of
    // deactivate() (ClosingWork.deferredSubscriptions over context.subscriptions).
    expect(source).toContain('subscriptions: closingWork.deferredSubscriptions(context.subscriptions),');
    expect(source).toContain('operationTarget: operationDockerTarget,');
    expect(source).toContain('heartbeats.imageBuilt();');
    // PR H (decision of 2026-10-09): changed expectation, the preparation passes the helper image maintenance of an
    // operation `open` on to the wiring (before: `prepareWorker(target, signal)`).
    expect(source).toContain('await heartbeats.prepareWorker(target, signal, maintenance);');
    expect(source).toContain('const repairSessionMonitor = heartbeats.repair(');
    expect(source).toContain('repair: repairSessionMonitor,');
    expect(source).not.toContain('new HeartbeatPreparation(');
    expect(source).not.toContain('heartbeatHelperImage(');
    expect(source).not.toMatch(/\.clearAll\(\)/);
  });
});

// Review round 6 of PR #85 (B-R6-1 to B-R6-6): the waits, the target and the failures of the heartbeat wiring.
describe('heartbeatWiring: waits, target and failures (review round 6 of PR #85)', () => {
  /** A deferred promise. */
  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** The wiring with builds that end only when the test ends them, and an operation target kept like runWithDockerTarget. */
  function setupBuilds() {
    const operation = new AsyncLocalStorage<DockerTarget>();
    const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
    const builds: { target: DockerTarget | undefined; signal: AbortSignal | undefined; done: ReturnType<typeof deferred<HelperImageUse>> }[] = [];
    const wiring = heartbeatWiring({
      preparation,
      helper: {
        ensureImagePresent: (options: PresentImageOptions): Promise<HelperImageUse> => {
          options.onBuild?.('create');
          const done = deferred<HelperImageUse>();
          builds.push({ target: operation.getStore(), signal: options.signal, done });
          return done.promise;
        },
        ensureImageUse: unexpectedEnsureImageUse,
        presentImage: async (): Promise<HelperImageUse | undefined> => undefined,
      },
      inTarget: (target, fn) => operation.run(target, fn),
      onOutput: () => {},
      operationTarget: () => undefined,
      subscriptions: { push: () => 0 },
    });
    return { operation, preparation, builds, wiring };
  }

  /** Whether `promise` settled (after the ready promises ran). */
  async function settledYet(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await settle();
    return settled;
  }

  it("the repair's signal ends its wait at once while the build goes on, and no monitor is started (B-R6-1)", async () => {
    const { preparation, builds, wiring } = setupBuilds();
    const started: DockerTarget[] = [];
    const deadline = new AbortController();
    // Plan step 11D2: changed, the ensure prepares its worker (as the flow does), then starts the monitor.
    const repairing = wiring.repair(async (target, signal) => {
      await wiring.prepareWorker(target, signal);
      started.push(target);
    })(LOCAL, deadline.signal);
    repairing.catch(() => undefined);
    await settle();
    expect(builds).toHaveLength(1);
    deadline.abort();
    expect(await settledYet(repairing)).toBe(true);
    await expect(repairing).rejects.toSatisfy(isAbortError);
    expect(started).toEqual([]);
    expect(builds[0].signal).not.toBe(deadline.signal);
    expect(builds[0].signal?.aborted).toBe(false);
    // The build ends later: still no monitor for the repair that gave up.
    builds[0].done.resolve(IMAGE);
    await settle();
    expect(started).toEqual([]);
    preparation.dispose();
  });

  it("in a heartbeat, the worker's signal ends its wait at once while the build goes on (B-R6-2)", async () => {
    const { preparation, builds, wiring } = setupBuilds();
    const deadline = new AbortController();
    const preparing = preparation.scope(() => wiring.prepareWorker(LOCAL, deadline.signal));
    preparing.catch(() => undefined);
    await settle();
    expect(builds).toHaveLength(1);
    deadline.abort();
    expect(await settledYet(preparing)).toBe(true);
    await expect(preparing).rejects.toSatisfy(isAbortError);
    expect(builds[0].signal).not.toBe(deadline.signal);
    expect(builds[0].signal?.aborted).toBe(false);
    preparation.dispose();
  });

  // Plan step 11D2: changed, the ensure gets the engine of the repair as its target (the flow goes to that engine);
  // before, it ran as an operation on it (runWithDockerTarget).
  it('the monitor is started on the engine of the repair (B-R6-3)', async () => {
    const { preparation, builds, wiring } = setupBuilds();
    const seen: DockerTarget[] = [];
    const repairing = wiring.repair(async (target, signal) => {
      await wiring.prepareWorker(target, signal);
      seen.push(target);
    })(REMOTE, new AbortController().signal);
    await settle();
    expect(builds[0].target).toBe(REMOTE);
    builds[0].done.resolve(IMAGE);
    await repairing;
    expect(seen).toEqual([REMOTE]);
    preparation.dispose();
  });

  it('the repair fails with the failure of the monitor, and ends only when the monitor did (B-R6-4)', async () => {
    const { preparation, builds, wiring } = setupBuilds();
    const monitor = deferred<void>();
    let called = 0;
    // Plan step 11D2: changed, the ensure prepares its worker first (as the flow does).
    const repair = wiring.repair(async (target, signal) => {
      await wiring.prepareWorker(target, signal);
      called += 1;
      return monitor.promise;
    });
    const repairing = repair(LOCAL, new AbortController().signal);
    repairing.catch(() => undefined);
    await settle();
    builds[0].done.resolve(IMAGE);
    await settle();
    expect(called).toBe(1);
    expect(await settledYet(repairing)).toBe(false);
    const failure = new Error('the Session Monitor container did not start');
    monitor.reject(failure);
    await expect(repairing).rejects.toBe(failure);
    // And a monitor that starts: the repair ends only then.
    const second = deferred<void>();
    const repairingAgain = wiring.repair(async (target, signal) => {
      await wiring.prepareWorker(target, signal);
      return second.promise;
    })(LOCAL, new AbortController().signal);
    await settle();
    builds[1].done.resolve(IMAGE);
    await settle();
    expect(await settledYet(repairingAgain)).toBe(false);
    second.resolve();
    await expect(repairingAgain).resolves.toBeUndefined();
    preparation.dispose();
  });

  it("outside a heartbeat, the worker's preparation is the user's: its own signal, never refused or joined, and it ends the wait (B-R6-5)", async () => {
    const { preparation, builds, wiring } = setupBuilds();
    // A failed build of a heartbeat on LOCAL: its engine waits.
    const failed = preparation.scope(() => wiring.prepareWorker(LOCAL, undefined));
    await settle();
    builds[0].done.reject(new Error('docker build failed'));
    await expect(failed).rejects.toThrow('docker build failed');
    await expect(preparation.scope(() => wiring.prepareWorker(LOCAL, undefined))).rejects.toThrow('prepared again in 60 seconds');
    expect(builds).toHaveLength(1);
    // The user's preparation within that wait: built with its own signal, and its success ends the wait.
    const user = new AbortController();
    const preparing = wiring.prepareWorker(LOCAL, user.signal);
    await settle();
    expect(builds).toHaveLength(2);
    expect(builds[1].signal).toBe(user.signal);
    expect(builds[1].target).toBe(LOCAL);
    builds[1].done.resolve(IMAGE);
    await expect(preparing).resolves.toBeUndefined();
    const heartbeat = preparation.scope(() => wiring.prepareWorker(LOCAL, undefined));
    await settle();
    expect(builds).toHaveLength(3);
    // While that heartbeat's build runs on LOCAL, the user's preparation starts its own, never joins it.
    const own = new AbortController();
    const preparingOwn = wiring.prepareWorker(LOCAL, own.signal);
    await settle();
    expect(builds).toHaveLength(4);
    expect(builds[3].signal).toBe(own.signal);
    builds[3].done.resolve(IMAGE);
    await expect(preparingOwn).resolves.toBeUndefined();
    expect(await settledYet(heartbeat)).toBe(false);
    builds[2].done.resolve(IMAGE);
    await expect(heartbeat).resolves.toBeUndefined();
    preparation.dispose();
  });

  it('extension.ts starts the monitor of a repair through monitorEnsure and retries the workers after a build (B-R6-6: X05, X06, X08)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'vscode', 'extension.ts'), 'utf8');
    // Plan step 11D2: changed, the operation `monitorEnsure` of the worker of the repair's engine (before:
    // monitorEnsure(remoteMonitor, engineSocket), removed with its test).
    // Plan step 11H2 (D1, decision of 2026-10-09): changed expectation, with the mode of the monitor of the repair's engine
    // (a remote target runs it permanently; was imageMaintenance() without it).
    expect(source).toContain("const repairSessionMonitor = heartbeats.repair((target, signal) => monitorCalls.monitorEnsure(target, imageMaintenance(target.kind === 'remote'), signal));");
    expect(source).not.toContain('ensureOrThrow(image.tag');
    expect(source).toMatch(/onImageBuilt: \(\) => \{\s*helperChannels\?\.clearFailures\(\);\s*heartbeats\.imageBuilt\(\);\s*\}/);
  });
});
