// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Background prebuild of the workspace helper image (user decision 2026-09-29: "there shall be no case where we need a
// previous helper image"). After an extension update the helper tag is new; the prebuild builds it right after the
// activation, in the background, so the first open after the update does not wait for it and does not fail when the
// network goes away later. Without a previous helper image, an open that finds no usable helper image and cannot build
// one fails with helperFailed.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../errors';
import { isAbortError, systemClock, type Clock, type Logger } from '../ports';
import { helperImageTag } from './helperImage';
import { readHelperState } from './helperState';
import type { WorkspaceHelper } from './workspaceHelper';

/**
 * What a prebuild did. `notDue`: helper.json knows the current tag; `remote`: the Docker context is not the local Docker;
 * `dockerNotRunning`: the local Docker does not answer; `busy`: another window prebuilds (its lock file exists); `built`:
 * the tag was missing and was built; `present`: the tag exists; `failed`: the build failed (the next open tries again);
 * `cancelled`: dispose ended it.
 */
export type HelperPrebuildOutcome = 'notDue' | 'remote' | 'dockerNotRunning' | 'busy' | 'built' | 'present' | 'failed' | 'cancelled';

/** The lock file of the prebuild, next to helper.json: only one window prebuilds (review round 5 of PR #64, R5-2). */
export const HELPER_PREBUILD_LOCK = 'helper-prebuild.lock';

/** A lock file older than this is left over by a window that ended without removing it: it is taken over. */
export const HELPER_PREBUILD_LOCK_STALE_MS = 30 * 60 * 1000;

export interface HelperPrebuildDeps {
  helper: Pick<WorkspaceHelper, 'usesLocalEngine' | 'prebuildImage'>;
  /** Whether the local Docker engine answers (`docker info`). Never throws, except an AbortError. */
  dockerRunning: (signal: AbortSignal) => Promise<boolean>;
  /** resources/helper/Dockerfile of the installed extension: its content gives the current helper tag. */
  dockerfilePath: string;
  /** `helper.json` of the local Docker (StoragePaths.helperState). The lock file is in the same folder. */
  statePath: string;
  logger: Logger;
  /** For the age of the lock file. Default: the system clock. */
  clock?: Clock;
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
 * started for this). Of the windows that start at the same time, only the one that creates the lock file
 * (HELPER_PREBUILD_LOCK) prebuilds; the others return `busy`. The build is the one of WorkspaceHelper.prebuildImage,
 * shared with ensureImage, so an open of the same window that starts meanwhile never builds a second time.
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
    const lock = await this.lock();
    if (lock === undefined) {
      deps.logger.info('The workspace helper image is not prepared in the background: another window prepares it.');
      return 'busy';
    }
    try {
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
    } finally {
      await fs.promises.unlink(lock).catch((error: unknown) => {
        deps.logger.warn(`The lock file ${lock} of the helper prebuild could not be removed: ${errorMessage(error)}`);
      });
    }
  }

  /** helper.json has no record of the current tag (or only a removal mark). */
  private async isDue(): Promise<boolean> {
    const { deps } = this;
    const tag = helperImageTag(await fs.promises.readFile(deps.dockerfilePath, 'utf8'));
    const record = (await readHelperState(deps.statePath)).images[tag];
    return record === undefined || record.removedAt !== undefined;
  }

  /**
   * Creates the lock file (exclusively) with the process ID and the time, and returns its path; `undefined` when another
   * window holds it. A lock file older than HELPER_PREBUILD_LOCK_STALE_MS is removed and the creation tried once more.
   */
  private async lock(): Promise<string | undefined> {
    const { deps } = this;
    const lockPath = path.join(path.dirname(deps.statePath), HELPER_PREBUILD_LOCK);
    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    const clock = deps.clock ?? systemClock;
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await fs.promises.open(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, time: new Date(clock.now()).toISOString() }));
        } finally {
          await handle.close();
        }
        return lockPath;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      if (attempt > 0) return undefined;
      let mtimeMs: number | undefined;
      try {
        mtimeMs = (await fs.promises.stat(lockPath)).mtimeMs;
      } catch (error) {
        // Removed meanwhile: it is created once more.
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      if (mtimeMs !== undefined) {
        if (clock.now() - mtimeMs <= HELPER_PREBUILD_LOCK_STALE_MS) return undefined;
        deps.logger.info(`The lock file ${lockPath} of the helper prebuild is old. It is taken over.`);
        await fs.promises.unlink(lockPath).catch((error: unknown) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        });
      }
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
