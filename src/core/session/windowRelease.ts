// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR C: the release of an environment that a window leaves, when it closes or switches to another
// environment (user decisions Q1 and Q2 of 2026-10-02). The local Node.js Session Monitor that stopped the container 30 s
// after the window closed is removed; instead the window
//   1. records the Git state of the environment itself (Q2 (c): in the running dev container as its user, the refresh
//      that Delete uses), bounded, and goes on when that fails;
//   2. sends the short release to the Session Monitor container of the engine: one heartbeat with the limit
//      max(waitingTimeSeconds, 60 s), so the monitor stops the environment after that time unless a window uses it again
//      (a reload within the waiting time sends its long heartbeats before it ends).
// Nothing is sent for an environment that is kept (Keep Running When Closed, Close and Keep Running, stopOnClose off, a
// respected "shutdownAction": "none": keptWhenClosed) or that another live window of this computer shows: their long
// heartbeats stay. A release that is lost (the window was killed, the bound passed, the engine did not answer) leaves the
// long limit of the last heartbeat (stopAfterMinutes): the safe side. Never throws; everything runs within `totalMs`.
// No `vscode`.
import { DEFAULT_WAITING_TIME_SECONDS } from '../busy';
import { errorMessage } from '../errors';
import type { Logger } from '../ports';
import { MAX_LIMIT_SECONDS, MIN_LIMIT_SECONDS } from '../remoteMonitor/protocol';
import type { Environment, ExtensionSettings } from '../types';
import { keepFlagsOf, keptWhenClosed } from './sessionRules';

/** The bounds of one release: all of it, and the Git record within it (ms). */
export interface ReleaseBounds {
  totalMs: number;
  gitMs: number;
}

/** In deactivate(): VS Code gives a closing window little time, so all of it within about 2 s. */
export const CLOSE_RELEASE_BOUNDS: ReleaseBounds = { totalMs: 2_000, gitMs: 1_000 };
/** A switch (the window leaves its environment and stays): more time; deactivate() waits for it within its own bound. */
export const SWITCH_RELEASE_BOUNDS: ReleaseBounds = { totalMs: 10_000, gitMs: 5_000 };

export type ReleaseOutcome = 'released' | 'kept' | 'inUse' | 'unknown' | 'failed';

/**
 * The limit of the release in whole seconds: the waiting time of the settings (waitingTimeSeconds; a missing or invalid
 * value gives its default of 30 s), at least the smallest limit of the protocol (60 s) and at most its largest.
 */
export function releaseLimitSeconds(waitingTimeSeconds: number | undefined): number {
  const seconds =
    typeof waitingTimeSeconds === 'number' && Number.isFinite(waitingTimeSeconds) && waitingTimeSeconds >= 0
      ? waitingTimeSeconds
      : DEFAULT_WAITING_TIME_SECONDS;
  return Math.min(MAX_LIMIT_SECONDS, Math.max(MIN_LIMIT_SECONDS, Math.ceil(seconds)));
}

export interface WindowReleaseDeps {
  registry: { list(): Promise<Environment[]> };
  settings: () => Pick<ExtensionSettings, 'stopOnClose' | 'respectShutdownActionNone' | 'waitingTimeSeconds'>;
  /** Another live, active window of this computer shows the environment (SessionCoordinator.otherActiveWindows). */
  otherWindowUses: (environmentId: string) => Promise<boolean>;
  /**
   * Q2 (c): records the Git state of the environment in its running dev container as its user
   * (EnvironmentService.recordGitState on the engine of the window). `signal` aborts at the bound.
   */
  recordGitState: (environment: Environment, signal: AbortSignal) => Promise<unknown>;
  /** The short release (WindowHeartbeats.release). `signal` aborts at the bound. */
  send: (environmentId: string, limitSeconds: number, signal: AbortSignal) => Promise<{ ok: true } | { ok: false; detail: string }>;
  logger: Logger;
}

/**
 * `run` within `ms`; then its signal aborts and the result is `undefined` (the work is not awaited further). An abort of
 * `parent` aborts it too.
 */
async function within<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T | undefined> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('The time for the release passed.'));
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}

/** The release of `environmentId` (see the module comment). Never throws; resolves within `bounds.totalMs`. */
export async function releaseEnvironment(deps: WindowReleaseDeps, environmentId: string, bounds: ReleaseBounds): Promise<ReleaseOutcome> {
  const started = Date.now();
  const outcome = await within(bounds.totalMs, async (signal): Promise<ReleaseOutcome> => {
    try {
      const environment = (await deps.registry.list()).find((candidate) => candidate.id === environmentId);
      if (environment === undefined) return 'unknown';
      const settings = deps.settings();
      if (keptWhenClosed(keepFlagsOf(environment), settings)) return 'kept';
      if (await deps.otherWindowUses(environmentId)) return 'inUse';
      if (signal.aborted) return 'failed';
      // Q2 (c): the Git state first, bounded; a failure is logged and the release goes on.
      const gitMs = Math.max(0, Math.min(bounds.gitMs, bounds.totalMs - (Date.now() - started)));
      try {
        await within(gitMs, (gitSignal) => deps.recordGitState(environment, gitSignal), signal);
      } catch (error) {
        deps.logger.info(`The Git state of ${environment.repository} could not be recorded before its release: ${errorMessage(error)}`);
      }
      if (signal.aborted) return 'failed';
      const limitSeconds = releaseLimitSeconds(settings.waitingTimeSeconds);
      const result = await deps.send(environmentId, limitSeconds, signal);
      if (!result.ok) {
        deps.logger.info(`The release of ${environment.repository} could not be sent (the long limit applies): ${result.detail}`);
        return 'failed';
      }
      deps.logger.info(`Released ${environment.repository}: the Session Monitor stops it after ${limitSeconds} seconds unless a window uses it again.`);
      return 'released';
    } catch (error) {
      deps.logger.info(`The release of the environment could not be sent (the long limit applies): ${errorMessage(error)}`);
      return 'failed';
    }
  });
  return outcome ?? 'failed';
}
