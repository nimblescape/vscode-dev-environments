// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 5 of PR #85 (B-R5-1): the wiring of the helper image for the heartbeats of a window, which extension.ts
// had inline: the preparation of the heartbeats (HeartbeatPreparation, disposed with the window), the end of its waits
// when a build of the helper image succeeded (WorkspaceHelper's onImageBuilt: the wait of the engine of the operation
// that built it, every wait when that engine is not known), the preparation of a worker (HelperChannels' `prepare`) and
// the repair of a Session Monitor container, both through heartbeatHelperImage. extension.ts uses it; here so the wiring
// is tested.
// No `vscode`.
import type { DockerTarget } from '../docker/dockerHost';
import { heartbeatHelperImage, type HeartbeatHelperImageDeps } from './heartbeatHelperImage';
import { HeartbeatPreparation } from './heartbeatPreparation';

export interface HeartbeatWiringDeps extends Omit<HeartbeatHelperImageDeps, 'preparation'> {
  /** The Docker target of the running operation (operationDockerTarget), `undefined` when it is not known. */
  operationTarget: () => DockerTarget | undefined;
  /** The disposables of the window (context.subscriptions): the preparation is disposed with it. */
  subscriptions: { push(disposable: { dispose(): void }): unknown };
  /** The preparation of the heartbeats (a new one by default). */
  preparation?: HeartbeatPreparation;
}

/**
 * Starts the Session Monitor container of `target` again. Plan step 11D2: the operation `monitorEnsure` of the worker of
 * `target`, which runs from the helper image (its preparation, below, gives it).
 */
export type EnsureMonitor = (target: DockerTarget, signal: AbortSignal) => Promise<void>;

export interface HeartbeatWiring {
  /** The preparation of the heartbeats (its scope for their send, repair and check). */
  readonly preparation: HeartbeatPreparation;
  /** HelperImages' onImageBuilt: a build succeeded, so the wait of its engine ends (every wait when not known). */
  imageBuilt(): void;
  /** HelperChannels' `prepare`: the helper image for the worker of `target`, through the preparation (its wait). */
  prepareWorker(target: DockerTarget, signal: AbortSignal | undefined): Promise<void>;
  /**
   * The repair of the Session Monitor container of a heartbeat: in the scope of a heartbeat, `ensureMonitor` on
   * `target` (plan step 11D2: the worker's operation; its preparation is the helper image through the preparation and
   * its wait, as for every operation of a heartbeat).
   */
  repair(ensureMonitor: EnsureMonitor): (target: DockerTarget, signal: AbortSignal) => Promise<void>;
}

export function heartbeatWiring(deps: HeartbeatWiringDeps): HeartbeatWiring {
  const preparation = deps.preparation ?? new HeartbeatPreparation();
  // The window closes: the preparations that its heartbeats started are aborted.
  deps.subscriptions.push({ dispose: () => preparation.dispose() });
  const image = heartbeatHelperImage({ preparation, helper: deps.helper, inTarget: deps.inTarget, onOutput: deps.onOutput });
  return {
    preparation,
    imageBuilt: () => {
      const built = deps.operationTarget();
      if (built !== undefined) preparation.clear(built);
      else preparation.clearAll();
    },
    prepareWorker: (target, signal) => image.prepareWorker(target, signal),
    repair: (ensureMonitor) => (target, signal) => preparation.scope(() => ensureMonitor(target, signal)),
  };
}
