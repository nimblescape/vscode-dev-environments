// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F2: the helper image (implementation notes 7) on the engine of an operation, apart from the steps of the
// workspace helper (workspaceHelper.ts), which run in the worker on the worker's own image. The extension prepares it
// for the bootstrap (the image of the worker and of the Session Monitor): it is checked, built when its tag is missing,
// rebuilt when a check of its base image asked for it, and old helper images are removed. No `vscode`.
import * as crypto from 'crypto';
import type { BootstrapDocker } from '../docker/bootstrapDocker';
import { UserFacingError, errorMessage, isUserFacingError } from '../errors';
import { Messages } from '../messages';
import { HELPER_DOCKER_SOCKET } from '../names';
import { abortError, isAbortError, systemClock, type Clock, type Logger } from '../ports';
import {
  HELPER_LAST_USED_INTERVAL_MS,
  currentHelperImageTag,
  ensureHelperImageUse,
  recordHelperImageUse,
  type BaseDigestLookup,
  type HelperBuildKind,
  type HelperImageUse,
} from './helperImage';

/** The part of BootstrapDocker that the helper image uses. */
export type HelperImageDocker = Pick<BootstrapDocker, 'imageExists' | 'imageId' | 'buildImage' | 'listImagesByLabel' | 'removeImage'>;

/** Plan step 11F2: the deps of HelperImages (before: the image part of HelperDeps of the workspace helper). */
export interface HelperImagesDeps {
  docker: HelperImageDocker;
  logger: Logger;
  /** resources/helper/Dockerfile of the installed extension. */
  dockerfilePath: string;
  /** Environment of the extension host. Only DOCKER_HOST is read (for the socket path); nothing of it enters the helper. */
  env: NodeJS.ProcessEnv;
  /** Default: the platform of this process. */
  platform?: NodeJS.Platform;
  clock?: Clock;
  /**
   * `helper.json` in the global storage folder (StoragePaths.helperState). With it, ensureImage also checks the base
   * image weekly (in the background), rebuilds the image when a check asked for it, and removes old helper images daily
   * (ensureHelperImage); the helper runs only build a missing tag and record the use. Without it, the image is only
   * built when its tag is missing.
   */
  statePath?: string;
  /** Current digest of the base image of the helper (registryBaseDigest). Without it, the base image is not checked. */
  baseDigest?: BaseDigestLookup;
  /** Called with each check of the base image that ensureImage starts in the background (for tests). */
  onBaseImageCheck?: (check: Promise<void>) => void;
  /**
   * Unit 7: the Docker engine that the operation uses (the current Docker context). `key` names it ('' for the local
   * Docker, else the remote host): the image found or built for one engine is not reused for another, and a remote
   * engine has its own state file. `socket`: the source of the socket mount on the machine of that engine (for a remote
   * host `/var/run/docker.sock`, or the recorded socket of a rootless engine); `endpoint`: the local endpoint of the
   * context, for helperDockerSocket. Without it, the local Docker of DOCKER_HOST.
   */
  engine?: () => Promise<HelperEngine>;
  /** Plan step 5, PR A: called after a build of the helper image succeeded (the worker can be opened again at once). */
  onImageBuilt?: () => void;

}

/** The options of HelperImages.ensureImagePresent. */
export interface PresentImageOptions {
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
  /** Review round 4 of PR #85 (A-R4-1): called when the call starts or joins a build of the helper image. */
  onBuild?: (kind: HelperBuildKind) => void;
}

/** See HelperImagesDeps.engine. */
export interface HelperEngine {
  key: string;
  socket?: string;
  endpoint?: string;
}

/**
 * The state file of the helper images of a remote engine: `helper.json` → `helper-remote-<hash>.json` (unit 7). The
 * state of the local Docker stays in `helper.json`.
 */
export function helperStatePathFor(statePath: string, engineKey: string): string {
  if (engineKey === '') return statePath;
  const hash = crypto.createHash('sha256').update(engineKey).digest('hex').slice(0, 16);
  return statePath.replace(/(\.json)?$/, `-remote-${hash}.json`);
}

/** Options of HelperImages.ensureImage. */
export interface EnsureImageOptions {
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
  /** `false` when the setting updateImagesOnConnect is off: no check of the base image (default `true`). */
  checkBaseImage?: boolean;
  /** Called right before a build of the helper image: `create` for a missing tag, `refresh` for a rebuild. */
  onBuild?: (kind: HelperBuildKind) => void;
}

/**
 * The result of ensureHelperImage that HelperImages caches, and the helper image of an open (see HelperImageUse in
 * helperImage.ts). Review round 3 of PR #64 (P2): the runs of an open use its `id`, for the current tag too.
 */
export type { HelperImageUse };

/**
 * ensureImage reuses its result for this long. After that, it runs ensureHelperImage again, so a window that stays open
 * for days still checks the base image and cleans up when that is due.
 */
export const HELPER_IMAGE_RECHECK_MS = 60 * 60 * 1000;

/** Path of the Docker socket inside the helper, and the default source of the socket mount. */
export const DOCKER_SOCKET = HELPER_DOCKER_SOCKET;


/**
 * Source of the socket mount (implementation notes 6). The source is a path on the machine of the Docker engine.
 * Assumption (V-7): Docker Desktop (macOS, Windows, and Linux) runs the engine in a VM, where the socket is
 * /var/run/docker.sock, whatever DOCKER_HOST points to on the computer. So a `unix://` DOCKER_HOST is used only on
 * Linux without Docker Desktop (for example rootless Docker Engine).
 */
export function helperDockerSocket(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, endpoint?: string): string {
  // Unit 7: the endpoint of the current Docker context (DOCKER_HOST when it is set), so a context of a local rootless
  // engine is followed like DOCKER_HOST.
  const host = (endpoint?.trim() || env.DOCKER_HOST?.trim()) ?? '';
  if (platform !== 'linux' || !host || !host.startsWith('unix://')) return DOCKER_SOCKET;
  const socketPath = host.slice('unix://'.length);
  if (!socketPath.startsWith('/') || socketPath.includes('/.docker/desktop/')) return DOCKER_SOCKET;
  return socketPath;
}

/** Plan step 11F2: the helper image of the operations of a window (see the module comment). */
export class HelperImages {
  private imagePromise: Promise<HelperImageUse> | undefined;
  /** Whether the cached image promise comes from ensureImage (with the maintenance), not from a helper run. */
  private imageMaintained = false;
  /** When the cached image promise resolved, and its tag. */
  private imageReadyAt: number | undefined;
  private imageTag: string | undefined;
  /**
   * Review round 4 of PR #64 (R4-1): the image ID of the cached result (HelperImageUse.id), set when it resolved. A pinned
   * run that finds no such image resets the cache when it still holds this ID, and ensureImage checks it before it reuses
   * the cache.
   */
  private imageCachedId: string | undefined;
  /** Last time this instance recorded a use of the tag in the state file. */
  private imageUsedAt: number | undefined;
  private readonly clock: Clock;
  /** The engine of the cached image (HelperImagesDeps.engine). */
  private imageEngine = '';
  /**
   * Review round 5 of PR #64 (R5-1): the build that the cached image promise has started (HelperBuildKind), until it
   * settles, and the onBuild callbacks of the callers that await it. A caller that joins the promise gets the progress
   * too: at once when the build has started, otherwise when it starts.
   */
  private imageBuilding: HelperBuildKind | undefined;
  private imageBuildListeners: Set<(kind: HelperBuildKind) => void> | undefined;

  private readonly logOutput = (text: string): void => this.deps.logger.output(text);

  constructor(private readonly deps: HelperImagesDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The engine of the operation (HelperImagesDeps.engine); the local Docker without it. */
  async currentEngine(): Promise<HelperEngine> {
    return (await this.deps.engine?.()) ?? { key: '' };
  }

  /** The source of the socket mount for the engine (see HelperImagesDeps.engine and helperDockerSocket). */
  socketPathFor(engine: HelperEngine): string {
    if (engine.socket !== undefined) return engine.socket;
    return helperDockerSocket(this.deps.env, this.deps.platform ?? process.platform, engine.endpoint);
  }

  private statePathFor(engine: HelperEngine): string | undefined {
    const statePath = this.deps.statePath;
    return statePath === undefined ? undefined : helperStatePathFor(statePath, engine.key);
  }

  /**
   * ensureHelperImage, shared by concurrent callers (cached promise; retried after a failure). With `statePath`, it also
   * does the maintenance that is due (implementation notes 7): a rebuild that a check asked for, the check of the base
   * image (in the background), the cleanup of old helper images. The open pipeline calls it before the helper runs; a
   * result older than HELPER_IMAGE_RECHECK_MS, or one of a helper run (without the maintenance), is not reused. A failed
   * build throws UserFacingError('helperFailed', Messages.helperFailed, detail); AbortError and other UserFacingErrors
   * pass through. Returns the tag.
   */
  async ensureImage(options: EnsureImageOptions = {}): Promise<string> {
    return (await this.ensureImageUse(options)).tag;
  }

  /**
   * ensureImage, with the helper image that this call awaited (HelperImageUse: the tag and the ID of its image). Review
   * round 3 of PR #64 (P1): the open pipeline pins this return value as the helper image
   * of the open and passes it as `image` to every helper run of the open, because the cache of this instance is shared by
   * all opens of the window and may be replaced meanwhile (another engine, a missing image at another run).
   */
  async ensureImageUse(options: EnsureImageOptions = {}): Promise<HelperImageUse> {
    return this.image(options, true);
  }

  /**
   * PR #74 review round 1 (A-R1-1): the helper image for the worker of the environment lock (Stop, Delete), on the engine
   * of the operation, local or remote alike. It only builds a missing tag, like the helper runs: no check of the base
   * image, no rebuild of an existing tag, no cleanup, so nothing long runs before the lock. A cached result whose image
   * is gone (a prune, or another window moved the tag) is not trusted: the cache is reset and the tag ensured again.
   * PR #74 review round 2, A-R2-1: it does not join a pending maintaining ensure of an open (a `--pull --no-cache`
   * rebuild, the cleanup), which the caller could not cancel: when the tag exists, its image is used at once (the worker
   * is pinned to its ID; a rebuild that moves the tag later cannot remove an image that a container uses). Only a missing
   * tag, or a tag that cannot be checked, joins it, like before. Throws like ensureImage. Review round 4 of PR #85
   * (A-R4-1): `onBuild` is called when the call starts or joins a build (a failure before it, such as an engine that
   * does not answer, is no failed build).
   */
  async ensureImagePresent(options: PresentImageOptions = {}): Promise<HelperImageUse> {
    const engine = await this.currentEngine();
    this.adoptEngine(engine.key);
    if (this.imagePromise && this.imageReadyAt !== undefined && !(await this.cachedImageCurrent())) this.resetImage();
    this.adoptEngine(engine.key);
    if (this.imagePromise && this.imageReadyAt === undefined && this.imageMaintained) {
      const present = await this.presentTag(options.signal);
      if (present !== undefined) return present;
      // The cache may have been replaced during the await (another engine): image() joins a promise of this engine.
      this.adoptEngine(engine.key);
    }
    return this.image({ onOutput: options.onOutput, signal: options.signal, onBuild: options.onBuild }, false);
  }

  /**
   * PR #76 review round 1 (A-R1-1, A-R1-2): whether the current helper tag exists on the engine of the operation, for the
   * refresh of the sidebar, which never builds it and never joins a pending build (its checks have time limits). Throws
   * UserFacingError('helperFailed') when the tag is missing or cannot be checked; an AbortError when `signal` aborts.
   */
  async checkImagePresent(options: { signal?: AbortSignal } = {}): Promise<void> {
    const present = await this.presentTag(options.signal);
    if (present === undefined) throw new UserFacingError('helperFailed', Messages.helperImageNotPresent);
  }

  /**
   * Review round 4 of PR #85 (A-R4-1): the current helper tag with the ID of its image when the tag exists on the engine
   * of the operation, else `undefined` (missing, or it cannot be checked); never builds and never joins a build (its
   * check has a time limit). An AbortError when `signal` aborts.
   */
  async presentImage(options: { signal?: AbortSignal } = {}): Promise<HelperImageUse | undefined> {
    return this.presentTag(options.signal);
  }

  /**
   * PR #74 review round 2, A-R2-1: the current helper tag with the ID of its image, when the tag exists; `undefined` when
   * it is missing or cannot be checked (the caller then joins or builds). It leaves the cache untouched and records no
   * use. An abort of `signal` passes through.
   */
  private async presentTag(signal: AbortSignal | undefined): Promise<HelperImageUse | undefined> {
    if (signal?.aborted) throw abortError();
    let tag: string | undefined;
    let id: string | undefined;
    try {
      tag = await currentHelperImageTag(this.deps.dockerfilePath);
      id = await this.deps.docker.imageId(tag);
    } catch (error) {
      this.deps.logger.warn(`The workspace helper image${tag !== undefined ? ` ${tag}` : ''} could not be checked: ${errorMessage(error)}`);
      id = undefined;
    }
    if (signal?.aborted) throw abortError();
    return tag !== undefined && id !== undefined ? { tag, id } : undefined;
  }

  /**
   * The key of the engine of the operation (HelperImagesDeps.engine; '' for the local Docker). Plan step 6, PR D: the
   * background prebuild reads the state file of this engine (helperStatePathFor), the one that an open on it writes.
   */
  async engineKey(): Promise<string> {
    return (await this.currentEngine()).key;
  }

  /**
   * Review round 1 of PR #113 (A-L2; round 2, A2-L3: its own place): the helper image of a step of the workspace helper without the image of an open
   * (the cache, without its maintenance: only a missing tag is built), for WorkspaceHelper. Plan step 11I (U7, decision
   * of 2026-10-08): WorkspaceHelper no longer calls it (it runs in the worker, from the worker's own image), so it has no
   * caller outside the tests; it stays with the rest of HelperImages, unchanged.
   */
  runImage(options: EnsureImageOptions): Promise<HelperImageUse> {
    return this.image(options, false);
  }

  /**
   * The background prebuild (user decision 2026-09-29: no previous helper image; HelperPrebuild): makes sure that the
   * helper tag exists on the engine of the operation, and builds it when it is missing, without the maintenance of
   * ensureImage (like the helper runs). It shares the cached promise of this instance with ensureImage and the helper
   * runs, so an open that starts meanwhile waits for this build instead of building a second time; when `signal` aborts,
   * the build is cancelled, and an open that waited for it builds again for itself. Plan step 6, PR D: on every engine,
   * local or remote (it no longer returns `undefined` for a remote one). Throws like ensureImage.
   */
  async prebuildImage(options: { signal: AbortSignal; onBuild?: (kind: HelperBuildKind) => void }): Promise<HelperImageUse> {
    return this.image({ signal: options.signal, onBuild: options.onBuild }, false);
  }


  /**
   * The helper image (HelperImageUse). `recheck` (ensureImage): ensureHelperImage with the maintenance; a result older
   * than HELPER_IMAGE_RECHECK_MS, or one of a helper run, is not reused. The helper runs (`recheck` false) reuse any result
   * and only record the use (at most once per hour); without a result (a new window), they run ensureHelperImage without
   * the maintenance, which only builds a missing tag. So no check of the base image, no rebuild, and no cleanup delays
   * a stop or a delete. Review round 2 of PR #64 (A-N1): a run with the helper image of an open
   * (`image`) does not use this cache; the open recorded the use when it resolved the image (ensureImage).
   */
  private async image(options: EnsureImageOptions, recheck: boolean): Promise<HelperImageUse> {
    const engine = await this.currentEngine();
    // Unit 7: an image of another engine (the Docker context changed) is not reused.
    this.adoptEngine(engine.key);
    const statePath = this.statePathFor(engine);
    if (recheck && this.imagePromise && !this.imageMaintained) {
      // The result of a helper run: wait until it is ready (a missing tag is built only once), then maintain.
      const pending = this.imagePromise;
      if (this.imageReadyAt === undefined) {
        try {
          await this.join(pending, options);
        } catch (error) {
          // Review round 5 of PR #64 (R5-1): the abort of this caller ends this call; a failure of the shared build
          // does not (it is tried again below).
          if (isAbortError(error) && options.signal?.aborted) throw error;
        }
      }
      if (this.imagePromise === pending) this.resetImage();
      // Review round 8 of PR #64 (R8-1): another open with another engine may have replaced the cache during the join.
      this.adoptEngine(engine.key);
    }
    if (this.imagePromise && this.imageReadyAt !== undefined) {
      const now = this.clock.now();
      if (recheck && Math.abs(now - this.imageReadyAt) >= HELPER_IMAGE_RECHECK_MS) this.resetImage();
      else if (recheck && !(await this.cachedImageCurrent())) this.resetImage();
      else await this.recordUse(now, statePath);
    }
    // Review round 8 of PR #64 (R8-1): another open with another engine may have replaced the cache during the awaits
    // above. No await follows until the join below, so the caller joins a promise of its own engine.
    this.adoptEngine(engine.key);
    if (!this.imagePromise) {
      // Review round 7 of PR #64 (R7-3): a caller cancelled during the awaits above starts no shared ensure, whose
      // rejection nothing would handle (join rejects at once for an aborted signal) and which could start a build.
      if (options.signal?.aborted) throw abortError();
      const listeners = new Set<(kind: HelperBuildKind) => void>();
      let built = false;
      const promise: Promise<HelperImageUse> = ensureHelperImageUse(this.deps.docker, this.deps.dockerfilePath, {
        onOutput: options.onOutput ?? this.logOutput,
        signal: options.signal,
        statePath,
        baseDigest: this.deps.baseDigest,
        maintain: recheck,
        checkBaseImage: options.checkBaseImage,
        // Review round 5 of PR #64 (R5-1): the progress reaches every caller that awaits this promise (join), not only
        // the caller that started it.
        onBuild: (kind) => {
          built = true;
          if (this.imagePromise === promise) this.imageBuilding = kind;
          for (const listener of [...listeners]) listener(kind);
        },
        onBaseImageCheck: this.deps.onBaseImageCheck,
        clock: this.clock,
        logger: this.deps.logger,
      }).then(
        (use) => {
          if (this.imagePromise === promise) {
            this.imageBuilding = undefined;
            this.imageReadyAt = this.clock.now();
            this.imageUsedAt = this.imageReadyAt;
            this.imageTag = use.tag;
            this.imageCachedId = use.id;
          }
          if (built) {
            try {
              this.deps.onImageBuilt?.();
            } catch (error) {
              this.deps.logger.warn(`The built helper image could not be reported: ${errorMessage(error)}`);
            }
          }
          return use;
        },
        (error: unknown) => {
          if (this.imagePromise === promise) {
            this.imagePromise = undefined;
            this.imageBuilding = undefined;
          }
          if (isAbortError(error) || isUserFacingError(error)) throw error;
          this.deps.logger.error('The workspace helper image could not be built.', error);
          throw new UserFacingError('helperFailed', Messages.helperFailed, errorMessage(error));
        },
      );
      this.imagePromise = promise;
      this.imageMaintained = recheck;
      this.imageBuilding = undefined;
      this.imageBuildListeners = listeners;
    }
    try {
      // Review round 3 of PR #64 (P1): the caller gets the image that it awaited, also when the cache was replaced
      // meanwhile (resetImage). Review round 5 of PR #64 (R5-1): its own signal ends its wait (join).
      return await this.join(this.imagePromise, options);
    } catch (error) {
      // Another caller cancelled the shared build: build again for this caller.
      if (isAbortError(error) && !options.signal?.aborted) return this.image(options, recheck);
      throw error;
    }
  }

  /**
   * Unit 7: makes `key` the engine of the cache; a cache of another engine is reset (its image is not reused). Review
   * round 8 of PR #64 (R8-1): called again after each await of `image`, because the opens of a window (each with the
   * engine of its operation) share the cache.
   */
  private adoptEngine(key: string): void {
    if (this.imagePromise && key !== this.imageEngine) this.resetImage();
    this.imageEngine = key;
  }

  private resetImage(): void {
    this.imagePromise = undefined;
    this.imageMaintained = false;
    this.imageReadyAt = undefined;
    this.imageCachedId = undefined;
    this.imageBuilding = undefined;
    this.imageBuildListeners = undefined;
  }

  /**
   * Review round 5 of PR #64 (R5-1): awaits the cached image promise `pending` (the current one) for one caller. The
   * signal of the caller ends only its own wait: it rejects with an AbortError at once (also when it was aborted before),
   * and the shared build goes on with the signal of the caller that started it. The onBuild of the caller gets the
   * progress of the shared build: at once when a build has started, otherwise when it starts, until `pending` settles.
   */
  private join(pending: Promise<HelperImageUse>, options: EnsureImageOptions): Promise<HelperImageUse> {
    const { signal, onBuild } = options;
    if (signal?.aborted) return Promise.reject(abortError());
    const listeners = this.imageBuildListeners;
    let listener: ((kind: HelperBuildKind) => void) | undefined;
    if (onBuild !== undefined) {
      if (this.imageBuilding !== undefined) onBuild(this.imageBuilding);
      else if (listeners !== undefined) {
        listener = (kind) => onBuild(kind);
        listeners.add(listener);
      }
    }
    if (signal === undefined && listener === undefined) return pending;
    return new Promise<HelperImageUse>((resolve, reject) => {
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (listener !== undefined) listeners?.delete(listener);
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (use) => {
          cleanup();
          resolve(use);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  /**
   * Review round 4 of PR #64 (R4-1): whether the resolved result in the cache is still the image of its tag, before an
   * open reuses it (ensureImage, within HELPER_IMAGE_RECHECK_MS). Another window may have rebuilt the tag (its old image
   * is then removed, or the containerd store drops it) or a prune may have removed it: an open would then pin an ID that
   * no longer exists and fail. `false` when the tag is gone or has another image now; `true` when Docker cannot answer
   * (the cache stays, as before the check) or when the cache changed meanwhile (the caller then awaits the new promise).
   */
  private async cachedImageCurrent(): Promise<boolean> {
    const promise = this.imagePromise;
    const tag = this.imageTag;
    const cachedId = this.imageCachedId;
    if (promise === undefined || tag === undefined) return true;
    let current: string | undefined;
    try {
      current = await this.deps.docker.imageId(tag);
    } catch (error) {
      this.deps.logger.warn(`The workspace helper image ${tag} could not be checked: ${errorMessage(error)}`);
      return true;
    }
    if (this.imagePromise !== promise) return true;
    if (current === cachedId) return true;
    this.deps.logger.info(
      current === undefined
        ? `The workspace helper image ${tag} was removed. It is prepared again.`
        : `The workspace helper image ${tag} has another image now. It is prepared again.`,
    );
    return false;
  }

  /** `lastUsedAt` of the tag in the state file, at most once per hour per instance. Never throws. */
  private async recordUse(now: number, statePath: string | undefined): Promise<void> {
    const tag = this.imageTag;
    if (statePath === undefined || tag === undefined) return;
    if (this.imageUsedAt !== undefined && Math.abs(now - this.imageUsedAt) < HELPER_LAST_USED_INTERVAL_MS) return;
    this.imageUsedAt = now;
    await recordHelperImageUse(statePath, tag, { clock: this.clock, logger: this.deps.logger });
  }
}
