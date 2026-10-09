// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Background prebuild of the workspace helper image (user decision 2026-09-29: "there shall be no case where we need a
// previous helper image"). After an extension update the helper tag is new; the prebuild builds it right after the
// activation, in the background, so the first open after the update does not wait for it and does not fail when the
// network goes away later. Without a previous helper image, an open that finds no usable helper image and cannot build
// one fails with helperFailed. Plan step 6, PR D (decision "Local and remote work the same" of 2026-09-30): it runs on the
// Docker engine of the current Docker context, local or remote alike. PR H (decision of 2026-10-09): with the setting
// updateImagesOnConnect on, it also runs when the refresh of the helper image is due (the rebuild that a check asked
// for, the weekly check of the base image), and its maintaining ensure then also runs the daily cleanup when that is due;
// the cleanup alone never makes it run.
import * as fs from 'fs';
import { LOCAL_DOCKER_TARGET, type DockerTarget } from '../docker/dockerHost';
import { runWithDockerTarget } from '../docker/dockerTargets';
import { REMOTE_INFO_TIMEOUT_MS, checkSshLogin, type SshCheckDeps } from '../docker/remoteDocker';
import { errorMessage } from '../errors';
import { isAbortError, type Logger } from '../ports';
import { helperImageTag, helperTimeLimit } from './helperImage';
import { readHelperState } from './helperState';
import { helperStatePathFor, type HelperImages } from './helperImages';

/**
 * What a prebuild did. `notDue`: the state file of the engine knows the current tag, and no refresh is due (PR H);
 * `unsupported`: the Docker endpoint is neither local nor SSH (plan step 6, PR D; `remote` is gone, a remote host is
 * prebuilt too); `dockerNotRunning`: the Docker engine does not answer; `built`: the tag was missing and was built;
 * `present`: the tag exists (PR H: also after the maintenance that was due, a rebuild that failed keeping the existing
 * image); `failed`: the build failed (the next open tries again); `cancelled`: dispose ended it.
 */
export type HelperPrebuildOutcome = 'notDue' | 'unsupported' | 'dockerNotRunning' | 'built' | 'present' | 'failed' | 'cancelled';

/**
 * PR #77 review round 1 (A-R1-1): the time limit of a prebuild, on every engine. Nobody can cancel the background prebuild, and an open that
 * joins its build can end only its own wait (R5-1); a build that stalls (a half-open SSH connection after a sleep) would
 * otherwise block every open and worker preparation on that engine until a reload. At the limit the build is ended. The
 * build of a missing tag fails, and a caller that waited for it builds for itself (with the layers that BuildKit
 * finished in its cache). Review round 1 of PR H (A-L3): a rebuild that a check asked for (`--pull --no-cache`, which
 * reuses no layer) counts as a failed rebuild instead, as the limit aborts with a time limit (helperTimeLimit): the
 * existing image is used, also by a caller that waited for it, and the next check is in a week, so the next start does
 * not repeat it.
 */
export const HELPER_PREBUILD_TIMEOUT_MS = 15 * 60_000;

export interface HelperPrebuildDeps {
  helper: Pick<HelperImages, 'engineKey' | 'prebuildImage' | 'refreshDue'>;
  /**
   * PR H (decision of 2026-10-09): the setting updateImagesOnConnect, read when the prebuild runs. With it on, the
   * rebuild that a check asked for and the weekly check of the base image make the prebuild due and run. The daily
   * cleanup never makes it due; it runs, with the setting on or off, whenever the prebuild runs and it is due too (the
   * setting governs the check and the rebuild, not the cleanup).
   */
  checkBaseImage: () => boolean;
  /**
   * Whether the Docker engine of `target` answers (dockerEngineAnswers); it never starts Docker. Called within the
   * operation on `target`. Never throws, except an AbortError.
   */
  dockerRunning: (target: DockerTarget, signal: AbortSignal) => Promise<boolean>;
  /** resources/helper/Dockerfile of the installed extension: its content gives the current helper tag. */
  dockerfilePath: string;
  /**
   * `helper.json` of the local Docker (StoragePaths.helperState). Plan step 6, PR D: a remote engine has its own state
   * file next to it (helperStatePathFor), the one that the open of that engine writes.
   */
  statePath: string;
  logger: Logger;
  /** The time limit of the prebuild (HELPER_PREBUILD_TIMEOUT_MS by default). */
  timeoutMs?: number;
}

/** What dockerEngineAnswers needs. */
export interface DockerEngineAnswersDeps {
  /** BootstrapDocker.daemonStatus: `docker info` in the context of the operation, directly (not through the worker). */
  daemonStatus: (signal: AbortSignal, timeoutMs?: number) => Promise<{ running: boolean }>;
  /** For the SSH check before a remote host (checkSshLogin). */
  ssh: SshCheckDeps;
  logger: Logger;
}

/**
 * Plan step 6, PR D: whether the Docker engine of `target` answers, for the prebuild; Docker is never started for it.
 * The local Docker: `docker info`. A remote host: first our own `ssh -o BatchMode=yes` (checkSshLogin, a success of the
 * last minute counts), so no password, passphrase or host key is ever asked, also on Windows where the ssh of the Docker
 * CLI could ask on a hidden console (review, C3); then `docker info` in the context of the operation with the time limit
 * of a remote host. An endpoint that is neither local nor SSH: false. Never throws, except an AbortError.
 */
export async function dockerEngineAnswers(target: DockerTarget, deps: DockerEngineAnswersDeps, signal: AbortSignal): Promise<boolean> {
  switch (target.kind) {
    case 'local':
      return (await deps.daemonStatus(signal)).running;
    case 'unsupported':
      return false;
    case 'remote': {
      const login = await checkSshLogin(target.host, deps.ssh, { signal });
      if (!login.ok) {
        deps.logger.info(`The Docker host ${target.host} cannot be reached over SSH: ${login.detail}`);
        return false;
      }
      // PR #77 review round 1 (A-R1-2): a host that our ssh cannot check would be asked by the ssh of the Docker CLI, which may ask a question;
      // nothing asks one unattended. The first open on that host builds the tag.
      if (login.skipped === 'notAnSshTarget') {
        deps.logger.info(`The workspace helper image is not prepared in the background on ${target.host}: it is no SSH address that can be checked without questions.`);
        return false;
      }
      return (await deps.daemonStatus(signal, REMOTE_INFO_TIMEOUT_MS)).running;
    }
  }
}

/**
 * The background prebuild. `start` runs it once (never rejects, never blocks: the caller does not await it); `dispose`
 * cancels it (the build of the Docker CLI is ended).
 *
 * It runs when the helper state file of the engine has no record of the current helper tag (after an update that
 * changed the tag, a first installation, or a tag that the cleanup removed), or (PR H, decision of 2026-10-09,
 * docs/plan-remote-worker.md section 2), with the setting updateImagesOnConnect on, when the refresh of that tag is due
 * by the state file (HelperImages.refreshDue: the rebuild that a check asked for, the weekly check of the base image,
 * which an attempt that the registry did not answer puts off by a week here: review round 1 of PR H, A-L2).
 * The daily cleanup alone never makes it due: it is housekeeping, and runs when the prebuild runs anyway and in the
 * preparation of the worker for an open. Review round 5 of PR #64 (R5-2): the state file alone decides, so a window that
 * starts after the prebuild of another one finds the record (and no refresh due) and does nothing. It asks Docker
 * nothing when it is not due, so an activation does not wake Docker Desktop from its Resource Saver mode, nor connect
 * to a remote host, for housekeeping. Plan step 6, PR D: on the Docker engine of the target that `start` gets, local
 * or remote alike (it runs as an operation on it, so the engine key, the state file and every Docker call are those of
 * an open on that engine), and only when that engine answers (Docker is never started for this). The ensure is the
 * maintaining one of HelperImages.prebuildImage (PR H: it builds a missing tag, runs the rebuild itself so that the next
 * open does not wait for it, starts the check, and runs the cleanup when that is due too), shared with the preparation
 * of a worker in the same window, so one that needs the missing tag meanwhile never builds a second time, and one before
 * an open joins the rebuild. Review round 6 of PR #64 (R6-1): there is no lock across windows (a lock left behind by a
 * window that closed during the prebuild would block the prebuild of every window). Windows that start at the same time
 * may each build the tag, or run the rebuild, once (BuildKit shares the layer cache; the extra images stay dangling
 * until the daily cleanup removes them); windows that start later find the record and no refresh due, and do nothing.
 */
export class HelperPrebuild {
  private readonly controller = new AbortController();
  private readonly limit = new AbortController();
  private run: Promise<HelperPrebuildOutcome> | undefined;

  constructor(private readonly deps: HelperPrebuildDeps) {}

  /**
   * Starts the prebuild once, as an operation on `target` (plan step 6, PR D; the local Docker by default); later calls
   * return the same promise. Never rejects.
   */
  start(target: DockerTarget = LOCAL_DOCKER_TARGET): Promise<HelperPrebuildOutcome> {
    this.run ??= runWithDockerTarget(target, () => this.prebuild(target)).catch((error: unknown) => {
      if (this.limit.signal.aborted && !this.controller.signal.aborted) {
        this.deps.logger.warn('The workspace helper image was not ready within the time limit of the background preparation; the next open prepares it.');
        return 'failed' as const;
      }
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

  private async prebuild(target: DockerTarget): Promise<HelperPrebuildOutcome> {
    const { deps } = this;
    // Review round 1 of PR H: a time limit, not a cancel, so a rebuild that it ends counts as a failed one.
    const timer = setTimeout(
      () => this.limit.abort(helperTimeLimit('The time limit of the background preparation of the workspace helper image ended.')),
      deps.timeoutMs ?? HELPER_PREBUILD_TIMEOUT_MS,
    );
    try {
      return await this.prebuildWithin(target, AbortSignal.any([this.controller.signal, this.limit.signal]));
    } finally {
      clearTimeout(timer);
    }
  }

  private async prebuildWithin(target: DockerTarget, signal: AbortSignal): Promise<HelperPrebuildOutcome> {
    const { deps } = this;
    if (target.kind === 'unsupported') {
      deps.logger.info(`The workspace helper image is not prepared in the background: the Docker endpoint ${target.endpoint} is neither local nor SSH.`);
      return 'unsupported';
    }
    if (!(await this.isDue(signal))) return signal.aborted ? 'cancelled' : 'notDue';
    if (signal.aborted) return 'cancelled';
    // Plan step 6, PR D: the local-only gate is gone; a remote host is prebuilt like the local Docker.
    if (!(await deps.dockerRunning(target, signal))) {
      deps.logger.info('The workspace helper image is not prepared in the background: Docker is not running. It is prepared at the next open.');
      return 'dockerNotRunning';
    }
    let built = false;
    // PR H (decision of 2026-10-09): the maintaining ensure, with the setting updateImagesOnConnect. A rebuild that fails
    // keeps the existing image (helperImage.ts logs it), so only the build of a missing tag counts as `built`.
    const use = await deps.helper.prebuildImage({
      signal,
      checkBaseImage: deps.checkBaseImage(),
      onBuild: (kind) => {
        if (kind === 'refresh') {
          deps.logger.info('The workspace helper image is built again in the background.');
          return;
        }
        built = true;
        deps.logger.info('The workspace helper image is built in the background.');
      },
    });
    deps.logger.info(
      built
        ? `The workspace helper image ${use.tag} was built in the background.`
        : `The workspace helper image ${use.tag} is ready.`,
    );
    return built ? 'built' : 'present';
  }

  /**
   * The state file of the engine has no record of the current tag (or only a removal mark), or (PR H) the refresh of the
   * tag is due by that file (HelperImages.refreshDue, with the setting updateImagesOnConnect; never the cleanup alone).
   * Plan step 6, PR D: the state file of the engine of the operation (helperStatePathFor with the engine key of an open),
   * read after the tag, so a dispose while the Dockerfile is read does not even read the engine. The engine key comes
   * from the target of the operation; Docker is not asked.
   */
  private async isDue(signal: AbortSignal): Promise<boolean> {
    const { deps } = this;
    const tag = helperImageTag(await fs.promises.readFile(deps.dockerfilePath, 'utf8'));
    if (signal.aborted) return false;
    const statePath = helperStatePathFor(deps.statePath, await deps.helper.engineKey());
    const record = (await readHelperState(statePath)).images[tag];
    if (record === undefined || record.removedAt !== undefined) return true;
    return deps.helper.refreshDue({ checkBaseImage: deps.checkBaseImage() });
  }
}
