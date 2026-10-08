// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { AsyncLocalStorage } from 'async_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { DockerTarget } from '../docker/dockerHost';
import type { HelperImageUse } from '../helper/helperImage';
import type { PresentImageOptions } from '../helper/helperImages';
import { HELPER_PREBUILD_TIMEOUT_MS } from '../helper/helperPrebuild';
import { isAbortError } from '../ports';
import { heartbeatHelperImage } from './heartbeatHelperImage';
import { HeartbeatPreparation } from './heartbeatPreparation';

const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const LOCAL: DockerTarget = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock', context: 'default' };
const REMOTE: DockerTarget = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box', context: 'devenv-remote-11111111' };
const IMAGE: HelperImageUse = { tag: 'devenv-helper:0123456789ab', id: 'sha256:1111' };

/** A helper whose tag is missing and whose build fails (or succeeds), with the targets its calls ran on. */
function setup() {
  const now = { value: T0 };
  const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => now.value });
  const state = { present: false, buildFails: true };
  const builds: DockerTarget[] = [];
  const checks: DockerTarget[] = [];
  let current: DockerTarget | undefined;
  const helper = {
    ensureImagePresent: async (options: PresentImageOptions): Promise<HelperImageUse> => {
      if (state.present) return IMAGE;
      options.onBuild?.('create');
      builds.push(current as DockerTarget);
      if (state.buildFails) throw new Error('docker build failed: no space left on device');
      state.present = true;
      return IMAGE;
    },
    presentImage: async (): Promise<HelperImageUse | undefined> => {
      checks.push(current as DockerTarget);
      return state.present ? IMAGE : undefined;
    },
  };
  const image = heartbeatHelperImage({
    preparation,
    helper,
    inTarget: async (target, fn) => {
      current = target;
      return fn();
    },
    onOutput: () => {},
  });
  return { now, preparation, state, builds, checks, image };
}

// Review round 4 of PR #85 (B-R4-1): the worker's preparation and the repair of a heartbeat share the wait of their engine.
// Plan step 11D2: changed, the repair is an operation of the worker (monitorEnsure), so its helper image is the worker's
// preparation (prepareWorker); before, a build of its own (repairImage, removed).
describe('heartbeatHelperImage (review round 4 of PR #85, B-R4-1)', () => {
  it('a failed build of a heartbeat, then a second preparation and a repair on the same engine: one build', async () => {
    const { preparation, builds, checks, image } = setup();
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('no space left');
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('prepared again in 60 seconds');
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('prepared again in 60 seconds');
    expect(builds).toEqual([LOCAL]);
    // Within the wait, only the presence of the tag was checked, on that engine.
    expect(checks).toEqual([LOCAL, LOCAL]);
    // Another engine has its own wait.
    await expect(preparation.scope(() => image.prepareWorker(REMOTE, undefined))).rejects.toThrow('no space left');
    expect(builds).toEqual([LOCAL, REMOTE]);
    preparation.dispose();
  });

  it('a failed build of a repair holds back the build of the next preparation of a worker on that engine', async () => {
    const { preparation, builds, image } = setup();
    // Plan step 11D2: changed, the repair's build is the preparation of its worker.
    await expect(preparation.scope(() => image.prepareWorker(REMOTE, undefined))).rejects.toThrow('no space left');
    await expect(preparation.scope(() => image.prepareWorker(REMOTE, undefined))).rejects.toThrow('prepared again');
    expect(builds).toEqual([REMOTE]);
    preparation.dispose();
  });

  it('within the wait, the worker and the repair go on with the tag when it is present', async () => {
    const { preparation, state, builds, image } = setup();
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('no space left');
    state.present = true;
    // Plan step 11D2: changed, the repair's worker is prepared as any other (before: repairImage answered the image).
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).resolves.toBeUndefined();
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).resolves.toBeUndefined();
    expect(builds).toEqual([LOCAL]);
    preparation.dispose();
  });

  it("an operation's preparation (outside the scope of a heartbeat) never waits, and its success ends the wait", async () => {
    const { preparation, state, builds, image } = setup();
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('no space left');
    await expect(image.prepareWorker(LOCAL, undefined)).rejects.toThrow('no space left');
    state.buildFails = false;
    await image.prepareWorker(LOCAL, undefined);
    state.present = false;
    state.buildFails = true;
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('no space left');
    expect(builds).toEqual([LOCAL, LOCAL, LOCAL, LOCAL]);
    preparation.dispose();
  });
});

/** prepareWorker (plan step 11D2: repairImage is removed). */
type Call = (target: DockerTarget, signal: AbortSignal | undefined) => Promise<unknown>;

/** Whether `promise` rejects with an AbortError within a few turns of the event loop. */
async function rejectsAtOnceWithAbort(promise: Promise<unknown>): Promise<boolean> {
  const outcome = await Promise.race([
    promise.then(
      () => 'resolved',
      (error: unknown) => (isAbortError(error) ? 'abort' : 'other'),
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 50)),
  ]);
  return outcome === 'abort';
}

// Review round 5 of PR #85: rules found by mutation, and the join of a running build per engine (A-R5-1).
describe('heartbeatHelperImage (review round 5 of PR #85)', () => {
  it('a second attempt on an engine joins its running build, also after a preparation on another engine reset the helper cache (A-R5-1)', async () => {
    const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
    const ambient = new AsyncLocalStorage<DockerTarget>();
    const builds: DockerTarget[] = [];
    // Like WorkspaceHelper: one cache of the image per window, reset by a preparation on another engine.
    let cache: { target: DockerTarget; image: Promise<HelperImageUse> } | undefined;
    const helper = {
      ensureImagePresent: (options: PresentImageOptions): Promise<HelperImageUse> => {
        const target = ambient.getStore() as DockerTarget;
        if (cache?.target === target) return cache.image;
        options.onBuild?.('create');
        builds.push(target);
        // The build on LOCAL hangs; the one on REMOTE succeeds.
        const image = target === LOCAL ? new Promise<HelperImageUse>(() => {}) : Promise.resolve(IMAGE);
        cache = { target, image };
        return image;
      },
      presentImage: async (): Promise<HelperImageUse | undefined> => undefined,
    };
    const image = heartbeatHelperImage({ preparation, helper, inTarget: (target, fn) => ambient.run(target, fn), onOutput: () => {} });
    const firstDeadline = new AbortController();
    const first = preparation.scope(() => image.prepareWorker(LOCAL, firstDeadline.signal));
    await vi.waitFor(() => expect(builds).toEqual([LOCAL]));
    await preparation.scope(() => image.prepareWorker(REMOTE, undefined));
    expect(builds).toEqual([LOCAL, REMOTE]);
    firstDeadline.abort();
    expect(await rejectsAtOnceWithAbort(first)).toBe(true);
    const secondDeadline = new AbortController();
    const second = preparation.scope(() => image.prepareWorker(LOCAL, secondDeadline.signal));
    // Plan step 11D2: changed, the repair's preparation is prepareWorker too.
    const repair = preparation.scope(() => image.prepareWorker(LOCAL, secondDeadline.signal));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(builds).toEqual([LOCAL, REMOTE]);
    secondDeadline.abort();
    expect(await rejectsAtOnceWithAbort(second)).toBe(true);
    expect(await rejectsAtOnceWithAbort(repair)).toBe(true);
    expect(builds).toEqual([LOCAL, REMOTE]);
    preparation.dispose();
  });

  // Plan step 11D2: changed, prepareWorker only (repairImage is removed; the repair prepares its worker).
  it.each(['prepareWorker'] as const)(
    "in the scope of a heartbeat, %s builds with the long signal: not the caller's, and not aborted with it (B-R5-2, I10)",
    async (method) => {
      const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
      const got: (AbortSignal | undefined)[] = [];
      const helper = {
        ensureImagePresent: (options: PresentImageOptions): Promise<HelperImageUse> => {
          got.push(options.signal);
          return new Promise<HelperImageUse>(() => {});
        },
        presentImage: async (): Promise<HelperImageUse | undefined> => undefined,
      };
      const image = heartbeatHelperImage({ preparation, helper, inTarget: (_target, fn) => fn(), onOutput: () => {} });
      const caller = new AbortController();
      const waiting = preparation.scope(() => (image[method] as Call)(LOCAL, caller.signal));
      await vi.waitFor(() => expect(got).toHaveLength(1));
      caller.abort();
      expect(await rejectsAtOnceWithAbort(waiting)).toBe(true);
      expect(got[0]).toBeDefined();
      expect(got[0]).not.toBe(caller.signal);
      expect(got[0]?.aborted).toBe(false);
      preparation.dispose();
      expect(got[0]?.aborted).toBe(true);
    },
  );

  // Plan step 11D2: changed, prepareWorker only (repairImage is removed; the repair prepares its worker).
  it.each(['prepareWorker'] as const)(
    'within the wait, %s checks the tag as an operation on its engine, with the signal of its caller (B-R5-3 I04, B-R5-5 I09)',
    async (method) => {
      const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
      const ambient = new AsyncLocalStorage<DockerTarget>();
      const checks: { target: DockerTarget | undefined; signal: AbortSignal | undefined }[] = [];
      const helper = {
        ensureImagePresent: async (options: PresentImageOptions): Promise<HelperImageUse> => {
          options.onBuild?.('create');
          throw new Error('docker build failed: no space left on device');
        },
        presentImage: async (options: { signal?: AbortSignal }): Promise<HelperImageUse | undefined> => {
          checks.push({ target: ambient.getStore(), signal: options.signal });
          return IMAGE;
        },
      };
      const image = heartbeatHelperImage({ preparation, helper, inTarget: (target, fn) => ambient.run(target, fn), onOutput: () => {} });
      await expect(preparation.scope(() => (image[method] as Call)(REMOTE, undefined))).rejects.toThrow('no space left');
      const caller = new AbortController();
      await preparation.scope(() => (image[method] as Call)(REMOTE, caller.signal));
      expect(checks).toEqual([{ target: REMOTE, signal: caller.signal }]);
      preparation.dispose();
    },
  );
});
