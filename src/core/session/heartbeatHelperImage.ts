// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 4 of PR #85 (B-R4-1, A-R4-1): the helper image for the heartbeats of a window, on the engine of each
// heartbeat: the preparation of its worker (HelperChannels' `prepare`) and the build of a repair of its Session Monitor
// container. Both go through HeartbeatPreparation with the engine (`target`), so a failed build on that engine backs off
// for both (A-R3-1), and both pass the presence check that lets a heartbeat go on within that wait when the tag is
// present (A-R4-1). extension.ts wires it; here so the wiring is tested.
// No `vscode`.
import type { DockerTarget } from '../docker/dockerHost';
import type { HelperImageUse } from '../helper/helperImage';
import type { PresentImageOptions } from '../helper/workspaceHelper';
import type { HeartbeatPreparation } from './heartbeatPreparation';

export interface HeartbeatHelperImageDeps {
  preparation: Pick<HeartbeatPreparation, 'prepare' | 'run'>;
  helper: {
    ensureImagePresent(options: PresentImageOptions): Promise<HelperImageUse>;
    presentImage(options: { signal?: AbortSignal }): Promise<HelperImageUse | undefined>;
  };
  /** Runs `fn` as an operation on `target` (runWithDockerTarget). */
  inTarget: <T>(target: DockerTarget, fn: () => Promise<T>) => Promise<T>;
  /** The output of a build. */
  onOutput: (text: string) => void;
}

export interface HeartbeatHelperImage {
  /** HelperChannels' `prepare`: the helper image for the worker of `target` (in the scope of a heartbeat, with its wait). */
  prepareWorker(target: DockerTarget, signal: AbortSignal | undefined): Promise<void>;
  /** The helper image for a repair of the Session Monitor container of `target`, with the same wait. */
  repairImage(target: DockerTarget, signal: AbortSignal | undefined): Promise<HelperImageUse>;
}

export function heartbeatHelperImage(deps: HeartbeatHelperImageDeps): HeartbeatHelperImage {
  const { preparation, helper, inTarget, onOutput } = deps;
  const ensure = (target: DockerTarget, signal: AbortSignal | undefined, onBuild: () => void): Promise<HelperImageUse> =>
    inTarget(target, () => helper.ensureImagePresent({ onOutput, signal, onBuild }));
  const present =
    (target: DockerTarget) =>
    (signal: AbortSignal | undefined): Promise<HelperImageUse | undefined> =>
      inTarget(target, () => helper.presentImage({ signal }));
  return {
    prepareWorker: async (target, signal) => {
      await preparation.prepare((preparing, onBuild) => ensure(target, preparing, onBuild), signal, target, present(target));
    },
    repairImage: (target, signal) => preparation.run((preparing, onBuild) => ensure(target, preparing, onBuild), signal, target, present(target)),
  };
}
