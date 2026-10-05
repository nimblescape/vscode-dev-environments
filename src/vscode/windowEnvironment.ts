// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The environment of the window at its activation (concept 7.8), and the restore of a lost registry around it (concept
// 7.5). Review round 1 of 11C3 (A-R1-M2): moved out of extension.ts (no `vscode` import here), so it is unit-tested.
import type { ContainerAdapter } from '../core/docker/containerAdapter';
import type { HelperPrebuildOutcome } from '../core/helper/helperPrebuild';
import type { EnvironmentOperations } from '../core/pipeline/environmentOperations';
import type { Logger } from '../core/ports';
import { errorMessage } from '../core/errors';
import type { EnvironmentRegistry } from '../core/storage/registry';
import type { Environment } from '../core/types';

/** Review round 1 of 11C3 (A-R1-M2): the longest wait of the activation for the restore of a lost registry. */
export const WINDOW_RESTORE_TIMEOUT_MS = 30_000;

/**
 * The registry entry of the container that this window is attached to. When the registry lost its content (concept 7.5
 * "registry lost": the file is missing, not valid, or has invalid entries), it is restored from the volume labels first,
 * so that the open pipeline of role A can run for a restored window; this needs a running Docker, which is not started
 * for it. Never throws.
 */
export async function findWindowEnvironment(
  containerName: string,
  deps: {
    registry: Pick<EnvironmentRegistry, 'findByContainerName'>;
    needsRestore: () => Promise<boolean>;
    docker: Pick<ContainerAdapter, 'isInstalled'>;
    service: Pick<EnvironmentOperations, 'reconcileInWorker'>;
    logger: Logger;
  },
): Promise<Environment | undefined> {
  const { registry, needsRestore, docker, service, logger } = deps;
  try {
    const environment = await registry.findByContainerName(containerName);
    if (environment || !(await needsRestore())) return environment;
    // Review D2: reconcileInWorker checks the Docker target first (never an endpoint that is neither local nor SSH),
    // then whether Docker runs. Plan step 11C3: by the worker of the Docker host, in the background (passive).
    if (!docker.isInstalled()) return undefined;
    // Review round 1 of 11C3 (A-R1-M2): the activation waits at most WINDOW_RESTORE_TIMEOUT_MS for it; the restore in the
    // background of the activation, and the one after the build of the helper image, adopt the window later
    // (reconcileIfRegistryLost with `adopt`).
    try {
      await service.reconcileInWorker({ passive: true, signal: AbortSignal.timeout(WINDOW_RESTORE_TIMEOUT_MS) });
    } catch (error) {
      logger.warn(`The environments could not be restored from the volumes while this window started: ${errorMessage(error)}`);
    }
    // Review round 2 of 11C3 (A-R2-M1): the registry is read again whatever the restore answered: it may have added the
    // entry before its time limit ended, or another window restored it first (nothing added here).
    return await registry.findByContainerName(containerName);
  } catch (error) {
    logger.error('The environment of this window could not be found.', error);
    return undefined;
  }
}

/**
 * Review round 1 of 11C3 (A-R1-M2): the restore at activation is passive (it never builds the helper image), so a lost
 * registry is restored again once the background preparation of the helper image ended with an image (`restore` adopts a
 * restored window). Review round 2 of 11C3 (A-R2-L1): also when the image was there already or is not due (a passive
 * restore may still have found no image, or no worker ready in time); `restore` makes the worker ready in full.
 */
export async function restoreAfterPrebuild(outcome: HelperPrebuildOutcome, restore: () => Promise<void>): Promise<void> {
  if (outcome === 'built' || outcome === 'present' || outcome === 'notDue') await restore();
}
