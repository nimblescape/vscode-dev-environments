// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Background prebuild of the workspace helper image (user decision 2026-09-29: "there shall be no case where we need a
// previous helper image"). After an extension update the helper tag is new; the prebuild builds it right after the
// activation, in the background, so the first open after the update does not wait for it and does not fail when the
// network goes away later. Without a previous helper image, an open that finds no usable helper image and cannot build
// one fails with helperFailed.
import * as fs from 'fs';
import { errorMessage } from '../errors';
import { isAbortError, type Logger } from '../ports';
import { helperImageTag } from './helperImage';
import { readHelperState } from './helperState';
import type { WorkspaceHelper } from './workspaceHelper';

/**
 * What a prebuild did. `notDue`: helper.json knows the current tag; `remote`: the Docker context is not the local Docker;
 * `dockerNotRunning`: the local Docker does not answer; `built`: the tag was missing and was built; `present`: the tag
 * exists; `failed`: the build failed (the next open tries again); `cancelled`: dispose ended it.
 */
export type HelperPrebuildOutcome = 'notDue' | 'remote' | 'dockerNotRunning' | 'built' | 'present' | 'failed' | 'cancelled';

export interface HelperPrebuildDeps {
  helper: Pick<WorkspaceHelper, 'usesLocalEngine' | 'prebuildImage'>;
  /** Whether the local Docker engine answers (`docker info`). Never throws, except an AbortError. */
  dockerRunning: (signal: AbortSignal) => Promise<boolean>;
  /** resources/helper/Dockerfile of the installed extension: its content gives the current helper tag. */
  dockerfilePath: string;
  /** `helper.json` of the local Docker (StoragePaths.helperState). */
  statePath: string;
  logger: Logger;
}

/**
 * The background prebuild. `start` runs it once (never rejects, never blocks: the caller does not await it); `dispose`
 * cancels it (the build of the Docker CLI is ended).
 *
 * It runs when helper.json of this installation has no record of the current helper tag (after an update that changed
 * the tag, a first installation, or a tag that the cleanup removed). Review round 5 of PR #64 (R5-2): helper.json alone
 * decides, so a window that starts after the build of another one finds the record and does nothing. It asks Docker
 * nothing when it is not due, so an activation does not wake Docker Desktop from its Resource Saver mode. Only on the
 * local Docker engine (a remote Docker host builds its helper at its first open), and only when Docker runs (it is never
 * started for this). The build is the one of WorkspaceHelper.prebuildImage, shared with ensureImage, so an open of the
 * same window that starts meanwhile never builds a second time. Review round 6 of PR #64 (R6-1): there is no lock across
 * windows (a lock left behind by a window that closed during the prebuild would block the prebuild of every window).
 * Windows that start at the same time may each build the tag once (BuildKit shares the layer cache; the extra images
 * are dangling and the daily cleanup removes them); windows that start later find the record and do nothing.
 */
export class HelperPrebuild {
  private readonly controller = new AbortController();
  private run: Promise<HelperPrebuildOutcome> | undefined;

  constructor(private readonly deps: HelperPrebuildDeps) {}

  /** Starts the prebuild once; later calls return the same promise. Never rejects. */
  start(): Promise<HelperPrebuildOutcome> {
    this.run ??= this.prebuild().catch((error: unknown) => {
      if (this.controller.signal.aborted || isAbortError(error)) return 'cancelled' as const;
      this.deps.logger.warn(`The workspace helper image could not be prepared in the background: ${errorMessage(error)}`);
      return 'failed' as const;
    });
    return this.run;
  }

  /** Cancels a prebuild that runs (on deactivation). */
  dispose(): void {
    this.controller.abort();
  }

  private async prebuild(): Promise<HelperPrebuildOutcome> {
    const { deps } = this;
    const signal = this.controller.signal;
    if (!(await this.isDue())) return 'notDue';
    if (signal.aborted) return 'cancelled';
    if (!(await deps.helper.usesLocalEngine())) {
      deps.logger.info('The workspace helper image is not prepared in the background: Docker is set to a remote host.');
      return 'remote';
    }
    if (!(await deps.dockerRunning(signal))) {
      deps.logger.info('The workspace helper image is not prepared in the background: Docker is not running. It is prepared at the next open.');
      return 'dockerNotRunning';
    }
    let built = false;
    const use = await deps.helper.prebuildImage({
      signal,
      onBuild: () => {
        built = true;
        deps.logger.info('The workspace helper image is built in the background.');
      },
    });
    if (use === undefined) return 'remote';
    deps.logger.info(
      built
        ? `The workspace helper image ${use.tag} was built in the background.`
        : `The workspace helper image ${use.tag} is ready.`,
    );
    return built ? 'built' : 'present';
  }

  /** helper.json has no record of the current tag (or only a removal mark). */
  private async isDue(): Promise<boolean> {
    const { deps } = this;
    const tag = helperImageTag(await fs.promises.readFile(deps.dockerfilePath, 'utf8'));
    const record = (await readHelperState(deps.statePath)).images[tag];
    return record === undefined || record.removedAt !== undefined;
  }
}
