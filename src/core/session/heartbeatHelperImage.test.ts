// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { DockerTarget } from '../docker/dockerHost';
import type { HelperImageUse } from '../helper/helperImage';
import type { PresentImageOptions } from '../helper/workspaceHelper';
import { HELPER_PREBUILD_TIMEOUT_MS } from '../helper/helperPrebuild';
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
describe('heartbeatHelperImage (review round 4 of PR #85, B-R4-1)', () => {
  it('a failed build of a heartbeat, then a second preparation and a repair on the same engine: one build', async () => {
    const { preparation, builds, checks, image } = setup();
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('no space left');
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('prepared again in 60 seconds');
    await expect(preparation.scope(() => image.repairImage(LOCAL, undefined))).rejects.toThrow('prepared again in 60 seconds');
    expect(builds).toEqual([LOCAL]);
    // Within the wait, only the presence of the tag was checked, on that engine.
    expect(checks).toEqual([LOCAL, LOCAL]);
    // Another engine has its own wait.
    await expect(preparation.scope(() => image.repairImage(REMOTE, undefined))).rejects.toThrow('no space left');
    expect(builds).toEqual([LOCAL, REMOTE]);
    preparation.dispose();
  });

  it('a failed build of a repair holds back the build of the next preparation of a worker on that engine', async () => {
    const { preparation, builds, image } = setup();
    await expect(preparation.scope(() => image.repairImage(REMOTE, undefined))).rejects.toThrow('no space left');
    await expect(preparation.scope(() => image.prepareWorker(REMOTE, undefined))).rejects.toThrow('prepared again');
    expect(builds).toEqual([REMOTE]);
    preparation.dispose();
  });

  it('within the wait, the worker and the repair go on with the tag when it is present', async () => {
    const { preparation, state, builds, image } = setup();
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('no space left');
    state.present = true;
    await expect(preparation.scope(() => image.repairImage(LOCAL, undefined))).resolves.toEqual(IMAGE);
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
