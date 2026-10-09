// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// PR H, a follow-up of plan step 11I (decision of 2026-10-09, docs/plan-remote-worker.md section 2): the preparation of
// the worker for an operation `open` (HelperMaintenance) runs the maintaining ensure (ensureImageUse) with the setting
// updateImagesOnConnect, the output of the window and the progress of the open; every other preparation (an operation,
// a heartbeat, a repair) keeps ensureImagePresent; and the back-off and wait rules of HeartbeatPreparation stay.
import { describe, expect, it } from 'vitest';
import type { DockerTarget } from '../docker/dockerHost';
import type { HelperBuildKind, HelperImageUse } from '../helper/helperImage';
import type { EnsureImageOptions, HelperMaintenance, PresentImageOptions } from '../helper/helperImages';
import { HELPER_PREBUILD_TIMEOUT_MS } from '../helper/helperPrebuild';
import { heartbeatHelperImage } from './heartbeatHelperImage';
import { HeartbeatPreparation } from './heartbeatPreparation';
import { heartbeatWiring } from './heartbeatWiring';

const T0 = Date.parse('2026-10-09T10:00:00.000Z');
const LOCAL: DockerTarget = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock', context: 'default' };
const IMAGE: HelperImageUse = { tag: 'devenv-helper:0123456789ab', id: 'sha256:1111' };

type Call = { kind: 'present'; options: PresentImageOptions } | { kind: 'maintain'; options: EnsureImageOptions } | { kind: 'check' };

/**
 * A helper whose ensures are recorded. `build`: the kind of the build that the next ensure reports (none: the tag is
 * there); `fails`: whether that build fails; `present`: whether the tag exists for the presence check of a waiting
 * heartbeat.
 */
function setup() {
  const state = { build: undefined as HelperBuildKind | undefined, fails: false, present: false };
  const calls: Call[] = [];
  const run = async (onBuild: ((kind: HelperBuildKind) => void) | undefined): Promise<HelperImageUse> => {
    if (state.build !== undefined) {
      onBuild?.(state.build);
      if (state.fails) throw new Error('docker build failed: no space left on device');
    }
    return IMAGE;
  };
  const helper = {
    ensureImagePresent: async (options: PresentImageOptions): Promise<HelperImageUse> => {
      calls.push({ kind: 'present', options });
      return run(options.onBuild);
    },
    ensureImageUse: async (options: EnsureImageOptions): Promise<HelperImageUse> => {
      calls.push({ kind: 'maintain', options });
      return run(options.onBuild);
    },
    presentImage: async (): Promise<HelperImageUse | undefined> => {
      calls.push({ kind: 'check' });
      return state.present ? IMAGE : undefined;
    },
  };
  const outputs: string[] = [];
  const onOutput = (text: string): void => {
    outputs.push(text);
  };
  const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
  const image = heartbeatHelperImage({ preparation, helper, inTarget: (_target, fn) => fn(), onOutput });
  const events: string[] = [];
  const maintenance = (checkBaseImage: boolean): HelperMaintenance => ({
    checkBaseImage,
    onBuild: (kind) => events.push(`build ${kind}`),
    onBuildEnd: () => events.push('end'),
  });
  return { state, calls, helper, onOutput, outputs, preparation, image, events, maintenance };
}

describe('the preparation of the worker for an open (PR H, decision of 2026-10-09)', () => {
  it('calls the maintaining ensure with the setting, the output of the window and the signal of the open; the others ensureImagePresent', async () => {
    const { calls, onOutput, preparation, image, maintenance } = setup();
    const signal = new AbortController().signal;
    await image.prepareWorker(LOCAL, signal, maintenance(false));
    await image.prepareWorker(LOCAL, signal, maintenance(true));
    expect(calls.map((call) => call.kind)).toEqual(['maintain', 'maintain']);
    const [off, on] = calls as Array<{ kind: 'maintain'; options: EnsureImageOptions }>;
    expect(off.options).toMatchObject({ checkBaseImage: false, signal, onOutput });
    expect(on.options).toMatchObject({ checkBaseImage: true, signal, onOutput });
    // Another operation, and a heartbeat (with the long signal of its scope): ensureImagePresent.
    await image.prepareWorker(LOCAL, signal);
    await preparation.scope(() => image.prepareWorker(LOCAL, undefined));
    expect(calls.map((call) => call.kind)).toEqual(['maintain', 'maintain', 'present', 'present']);
    preparation.dispose();
  });

  it('heartbeatWiring passes the maintenance of an open on (HelperChannels prepare), and none for the others', async () => {
    const { calls, helper, preparation, maintenance } = setup();
    const wiring = heartbeatWiring({ preparation, helper, inTarget: (_target, fn) => fn(), onOutput: () => {}, operationTarget: () => undefined, subscriptions: { push: () => 0 } });
    await wiring.prepareWorker(LOCAL, undefined, maintenance(true));
    await wiring.prepareWorker(LOCAL, undefined);
    expect(calls.map((call) => call.kind)).toEqual(['maintain', 'present']);
    expect(calls[0]).toMatchObject({ options: { checkBaseImage: true } });
    preparation.dispose();
  });

  it('reports the kind of its build and the end of the preparation, also when the build fails; nothing without a build', async () => {
    const { state, preparation, image, events, maintenance } = setup();
    await image.prepareWorker(LOCAL, undefined, maintenance(true));
    expect(events).toEqual([]);
    state.build = 'refresh';
    await image.prepareWorker(LOCAL, undefined, maintenance(true));
    expect(events).toEqual(['build refresh', 'end']);
    state.build = 'create';
    state.fails = true;
    await expect(image.prepareWorker(LOCAL, undefined, maintenance(true))).rejects.toThrow('no space left');
    expect(events).toEqual(['build refresh', 'end', 'build create', 'end']);
    preparation.dispose();
  });

  it('never waits for the back-off of its engine, a failed build of it starts none, and its success ends the wait', async () => {
    const { state, calls, preparation, image, maintenance } = setup();
    state.build = 'create';
    state.fails = true;
    // A heartbeat's build fails: its engine waits; within the wait a heartbeat only checks the tag, and is refused.
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('no space left');
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('prepared again in 60 seconds');
    expect(calls.map((call) => call.kind)).toEqual(['present', 'check']);
    // The open's preparation is not held back by the wait: it builds, and its failure is its own.
    await expect(image.prepareWorker(LOCAL, undefined, maintenance(true))).rejects.toThrow('no space left');
    expect(calls.map((call) => call.kind)).toEqual(['present', 'check', 'maintain']);
    // Its failure neither ended nor lengthened the wait (60 seconds, not the 120 of a second failure).
    await expect(preparation.scope(() => image.prepareWorker(LOCAL, undefined))).rejects.toThrow('prepared again in 60 seconds');
    expect(calls.map((call) => call.kind)).toEqual(['present', 'check', 'maintain', 'check']);
    // Its success (a failed rebuild resolves too: the tag keeps its image) ends the wait: the next heartbeat prepares
    // its worker again (ensureImagePresent) instead of only checking the tag.
    state.build = 'refresh';
    state.fails = false;
    await image.prepareWorker(LOCAL, undefined, maintenance(true));
    state.build = undefined;
    await preparation.scope(() => image.prepareWorker(LOCAL, undefined));
    expect(calls.map((call) => call.kind)).toEqual(['present', 'check', 'maintain', 'check', 'maintain', 'present']);
    preparation.dispose();
  });
});
