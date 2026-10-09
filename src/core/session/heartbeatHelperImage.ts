// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 4 of PR #85 (B-R4-1, A-R4-1): the helper image for the heartbeats of a window, on the engine of each
// heartbeat: the preparation of its worker (HelperChannels' `prepare`). Plan step 11D2: a repair of the Session Monitor
// container is an operation of that worker, so it gets the image through the same preparation (before, a build of its
// own here). Both go through HeartbeatPreparation with the engine (`target`), so a failed build on that engine backs off
// for both (A-R3-1), and both pass the presence check that lets a heartbeat go on within that wait when the tag is
// present (A-R4-1). PR H (decision of 2026-10-09): the preparation of the worker for an operation `open`
// (HelperMaintenance) runs the maintaining ensure instead, through the same preparation and its rules. extension.ts
// wires it; here so the wiring is tested.
// No `vscode`.
import type { DockerTarget } from '../docker/dockerHost';
import type { HelperImageUse } from '../helper/helperImage';
import type { EnsureImageOptions, HelperMaintenance, PresentImageOptions } from '../helper/helperImages';
import type { HeartbeatPreparation } from './heartbeatPreparation';

export interface HeartbeatHelperImageDeps {
  preparation: Pick<HeartbeatPreparation, 'prepare'>;
  helper: {
    ensureImagePresent(options: PresentImageOptions): Promise<HelperImageUse>;
    /** PR H: the maintaining ensure (HelperImages.ensureImageUse), for the preparation of the worker for an open. */
    ensureImageUse(options: EnsureImageOptions): Promise<HelperImageUse>;
    presentImage(options: { signal?: AbortSignal }): Promise<HelperImageUse | undefined>;
  };
  /** Runs `fn` as an operation on `target` (runWithDockerTarget). */
  inTarget: <T>(target: DockerTarget, fn: () => Promise<T>) => Promise<T>;
  /** The output of a build. */
  onOutput: (text: string) => void;
}

export interface HeartbeatHelperImage {
  /**
   * HelperChannels' `prepare`: the helper image for the worker of `target` (in the scope of a heartbeat, with its wait).
   * PR H (decision of 2026-10-09): with `maintenance` (only the preparation for an operation `open`), the maintaining
   * ensure (ensureImageUse with its setting updateImagesOnConnect: the rebuild that a check asked for, the weekly check of
   * the base image, the daily cleanup), with the progress of the open; without it, ensureImagePresent (only a missing
   * tag is built).
   */
  prepareWorker(target: DockerTarget, signal: AbortSignal | undefined, maintenance?: HelperMaintenance): Promise<void>;
}

export function heartbeatHelperImage(deps: HeartbeatHelperImageDeps): HeartbeatHelperImage {
  const { preparation, helper, inTarget, onOutput } = deps;
  const ensure = (target: DockerTarget, signal: AbortSignal | undefined, onBuild: () => void): Promise<HelperImageUse> =>
    inTarget(target, () => helper.ensureImagePresent({ onOutput, signal, onBuild }));
  // PR H: the maintaining ensure of the preparation for an open. `onBuild` of the preparation counts the build (A-R4-1);
  // the open gets its kind, and the end of the preparation once it got a kind (its progress detail is cleared).
  const maintain = async (target: DockerTarget, signal: AbortSignal | undefined, onBuild: () => void, maintenance: HelperMaintenance): Promise<HelperImageUse> => {
    let reported = false;
    try {
      return await inTarget(target, () =>
        helper.ensureImageUse({
          onOutput,
          signal,
          checkBaseImage: maintenance.checkBaseImage,
          onBuild: (kind) => {
            onBuild();
            reported = true;
            maintenance.onBuild?.(kind);
          },
        }),
      );
    } finally {
      if (reported) maintenance.onBuildEnd?.();
    }
  };
  const present =
    (target: DockerTarget) =>
    (signal: AbortSignal | undefined): Promise<HelperImageUse | undefined> =>
      inTarget(target, () => helper.presentImage({ signal }));
  return {
    prepareWorker: async (target, signal, maintenance) => {
      await preparation.prepare(
        (preparing, onBuild) => (maintenance === undefined ? ensure(target, preparing, onBuild) : maintain(target, preparing, onBuild, maintenance)),
        signal,
        target,
        present(target),
      );
    },
  };
}
