// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Background prebuild of the workspace helper image (user decision 2026-09-29: "there shall be no case where we need a
// previous helper image"). After an extension update the helper tag is new; the prebuild builds it right after the
// activation, in the background, so the first open after the update does not wait for it and does not fail when the
// network goes away later. Without a previous helper image, an open that finds no usable helper image and cannot build
// one fails with helperFailed. Plan step 6, PR D (decision "Local and remote work the same" of 2026-09-30): it runs on the
// Docker engine of the current Docker context, local or remote alike.
import * as fs from 'fs';
import { LOCAL_DOCKER_TARGET, type DockerTarget } from '../docker/dockerHost';
import { runWithDockerTarget } from '../docker/dockerTargets';
import { REMOTE_INFO_TIMEOUT_MS, checkSshLogin, type SshCheckDeps } from '../docker/remoteDocker';
import { errorMessage } from '../errors';
import { isAbortError, type Logger } from '../ports';
import { helperImageTag } from './helperImage';
import { readHelperState } from './helperState';
import { helperStatePathFor, type WorkspaceHelper } from './workspaceHelper';

/**
 * What a prebuild did. `notDue`: the state file of the engine knows the current tag; `unsupported`: the Docker endpoint
 * is neither local nor SSH (plan step 6, PR D; `remote` is gone, a remote host is prebuilt too); `dockerNotRunning`: the
 * Docker engine does not answer; `built`: the tag was missing and was built; `present`: the tag exists; `failed`: the
 * build failed (the next open tries again); `cancelled`: dispose ended it.
 */
export type HelperPrebuildOutcome = 'notDue' | 'unsupported' | 'dockerNotRunning' | 'built' | 'present' | 'failed' | 'cancelled';

export interface HelperPrebuildDeps {
  helper: Pick<WorkspaceHelper, 'engineKey' | 'prebuildImage'>;
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
}

/** What dockerEngineAnswers needs. */
export interface DockerEngineAnswersDeps {
  /** ContainerAdapter.daemonStatus: `docker info` in the context of the operation, directly (not through the worker). */
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
      return (await deps.daemonStatus(signal, REMOTE_INFO_TIMEOUT_MS)).running;
    }
  }
}

/**
 * The background prebuild. `start` runs it once (never rejects, never blocks: the caller does not await it); `dispose`
 * cancels it (the build of the Docker CLI is ended).
 *
 * It runs when the helper state file of the engine has no record of the current helper tag (after an update that
 * changed the tag, a first installation, or a tag that the cleanup removed). Review round 5 of PR #64 (R5-2): the state
 * file alone decides, so a window that starts after the build of another one finds the record and does nothing. It asks
 * Docker nothing when it is not due, so an activation does not wake Docker Desktop from its Resource Saver mode, nor
 * connect to a remote host. Plan step 6, PR D: on the Docker engine of the target that `start` gets, local or remote
 * alike (it runs as an operation on it, so the engine key, the state file and every Docker call are those of an open on
 * that engine), and only when that engine answers (Docker is never started for this). The build is the one of WorkspaceHelper.prebuildImage, shared with ensureImage, so an open of the
 * same window that starts meanwhile never builds a second time. Review round 6 of PR #64 (R6-1): there is no lock across
 * windows (a lock left behind by a window that closed during the prebuild would block the prebuild of every window).
 * Windows that start at the same time may each build the tag once (BuildKit shares the layer cache; the extra images
 * are dangling and the daily cleanup removes them); windows that start later find the record and do nothing.
 */
export class HelperPrebuild {
  private readonly controller = new AbortController();
  private run: Promise<HelperPrebuildOutcome> | undefined;

  constructor(private readonly deps: HelperPrebuildDeps) {}

  /**
   * Starts the prebuild once, as an operation on `target` (plan step 6, PR D; the local Docker by default); later calls
   * return the same promise. Never rejects.
   */
  start(target: DockerTarget = LOCAL_DOCKER_TARGET): Promise<HelperPrebuildOutcome> {
    this.run ??= runWithDockerTarget(target, () => this.prebuild(target)).catch((error: unknown) => {
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
    const signal = this.controller.signal;
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
    const use = await deps.helper.prebuildImage({
      signal,
      onBuild: () => {
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
   * The state file of the engine has no record of the current tag (or only a removal mark). Plan step 6, PR D: the state
   * file of the engine of the operation (helperStatePathFor with the engine key of an open), read after the tag, so a
   * dispose while the Dockerfile is read does not even read the engine. The engine key comes from the target of the
   * operation; Docker is not asked.
   */
  private async isDue(signal: AbortSignal): Promise<boolean> {
    const { deps } = this;
    const tag = helperImageTag(await fs.promises.readFile(deps.dockerfilePath, 'utf8'));
    if (signal.aborted) return false;
    const statePath = helperStatePathFor(deps.statePath, await deps.helper.engineKey());
    const record = (await readHelperState(statePath)).images[tag];
    return record === undefined || record.removedAt !== undefined;
  }
}
