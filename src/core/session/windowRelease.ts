// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR C: the release of an environment that a window leaves, when it closes or switches to another
// environment (user decisions Q1 and Q2 of 2026-10-02). The local Node.js Session Monitor that stopped the container 30 s
// after the window closed is removed; instead the window
//   1. records the Git state of the environment itself (Q2 (c): in the running dev container as its user, the refresh
//      that Delete uses), bounded, and goes on when that fails;
//   2. sends the short release to the Session Monitor container of the engine: one heartbeat with the limit
//      max(waitingTimeSeconds, 60 s) plus RELEASE_MARGIN_SECONDS, marked as a release (`release: true`), so the monitor
//      stops the environment after that time unless a window uses it again (a reload sends its long heartbeat at once
//      when it starts, SessionCoordinator.start; review round 1 of PR #87, A-R1-1).
// Nothing is sent for an environment that is kept (Keep Running When Closed, Close and Keep Running, stopOnClose off, a
// respected "shutdownAction": "none": keptWhenClosed) or that another window of this computer uses: its status file or
// its pending connection file (otherWindowUsesEnvironment), or its live busy mark on the environment (review round 1 of
// PR #87, A-R1-2: those windows share this computer's record, which the release would shorten); their long heartbeats
// stay. The monitor never lets a release shorten the live record of another computer (rules.ts, decide). A release that is lost (the window was killed, the bound passed, the engine did not answer) leaves the
// long limit of the last heartbeat (stopAfterMinutes): the safe side. Never throws; everything runs within `totalMs`.
// No `vscode`.
import { DEFAULT_WAITING_TIME_SECONDS, isBusyMarkLive, otherWindowUsesEnvironment, type OtherWindowInput } from '../busy';
import { errorMessage } from '../errors';
import type { Logger } from '../ports';
import { MAX_LIMIT_SECONDS, MIN_LIMIT_SECONDS } from '../remoteMonitor/protocol';
import type { Environment, ExtensionSettings } from '../types';
import { keepFlagsOf, keptWhenClosed } from './sessionRules';
import { HEARTBEAT_ATTEMPT_DEADLINE_MS, WINDOW_HEARTBEAT_INTERVAL_MS } from './windowHeartbeats';

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
 * Review round 1 of PR #87 (A-R1-1): added to the waiting time of a release. A window that comes back (a reload of the
 * same window, a switch back) sends its first long heartbeat at once when it starts, but that heartbeat may take one
 * attempt (HEARTBEAT_ATTEMPT_DEADLINE_MS: the lookup of the engine, the check of the container, the worker, the repair),
 * and after a failure the next one follows within WINDOW_HEARTBEAT_INTERVAL_MS. So the release lasts that much longer
 * than the waiting time, and the monitor does not stop the environment while the window attaches again.
 */
export const RELEASE_MARGIN_SECONDS = (WINDOW_HEARTBEAT_INTERVAL_MS + HEARTBEAT_ATTEMPT_DEADLINE_MS) / 1000;

/**
 * The limit of the release in whole seconds: the waiting time of the settings (waitingTimeSeconds; a missing or invalid
 * value gives its default of 30 s), at least the smallest limit of the protocol (60 s), plus RELEASE_MARGIN_SECONDS
 * (review round 1 of PR #87, A-R1-1), and at most the largest limit of the protocol.
 */
export function releaseLimitSeconds(waitingTimeSeconds: number | undefined): number {
  const seconds =
    typeof waitingTimeSeconds === 'number' && Number.isFinite(waitingTimeSeconds) && waitingTimeSeconds >= 0
      ? waitingTimeSeconds
      : DEFAULT_WAITING_TIME_SECONDS;
  return Math.min(MAX_LIMIT_SECONDS, Math.max(MIN_LIMIT_SECONDS, Math.ceil(seconds)) + RELEASE_MARGIN_SECONDS);
}

/**
 * Review round 1 of PR #87 (A-R1-2): whether a window of this computer other than `ownWindowId` uses `environment`, so
 * this window must not release it (all windows of a computer share one heartbeat record per environment, and a release
 * would shorten it): its status file or its fresh pending connection file names the environment
 * (otherWindowUsesEnvironment), or it holds a live busy mark on it (isBusyMarkLive, with the status files: an open or a
 * rebuild that runs there). Pure.
 */
export function otherWindowHoldsEnvironment(environment: Environment, ownWindowId: string, input: OtherWindowInput): boolean {
  if (otherWindowUsesEnvironment(environment.id, ownWindowId, input) !== undefined) return true;
  const mark = environment.busy;
  if (mark === undefined || mark.windowId === ownWindowId) return false;
  return isBusyMarkLive(mark, { now: input.now, isAlive: input.isAlive, windowStatuses: input.windowStatuses ?? [] });
}

export interface WindowReleaseDeps {
  registry: { list(): Promise<Environment[]> };
  settings: () => Pick<ExtensionSettings, 'stopOnClose' | 'respectShutdownActionNone' | 'waitingTimeSeconds'>;
  /**
   * Another window of this computer uses the environment (SessionCoordinator.otherWindowUses: otherWindowHoldsEnvironment
   * with its status files and pending connection files; review round 1 of PR #87, A-R1-2). True also when that is not
   * known (a file could not be read): then nothing is released.
   */
  otherWindowUses: (environment: Environment) => Promise<boolean>;
  /**
   * Q2 (c): records the Git state of the environment in its running dev container as its user
   * (EnvironmentService.recordGitState on the engine of the window). `signal` aborts at the bound.
   */
  recordGitState: (environment: Environment, signal: AbortSignal) => Promise<unknown>;
  /**
   * Review round 2 of PR #87 (A-R2-2): records that this window was seen using the environment at `at` (an ISO time
   * taken at the start of the release, before the Git step: EnvironmentRegistry.markSeenInUse), for Delete's note. It
   * runs alongside the rest of the release and is awaited before it ends (within its bound); a failure is logged.
   */
  markSeenInUse?: (environment: Environment, at: string) => Promise<unknown>;
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

/** Review round 2 of PR #87 (A-R2-2): the time left of the bound when the release stops waiting for markSeenInUse. */
const SEEN_MARGIN_MS = 100;

/** The release of `environmentId` (see the module comment). Never throws; resolves within `bounds.totalMs`. */
export async function releaseEnvironment(deps: WindowReleaseDeps, environmentId: string, bounds: ReleaseBounds): Promise<ReleaseOutcome> {
  const started = Date.now();
  const outcome = await within(bounds.totalMs, async (signal): Promise<ReleaseOutcome> => {
    let seen: Promise<void> | undefined;
    try {
      const environment = (await deps.registry.list()).find((candidate) => candidate.id === environmentId);
      if (environment === undefined) return 'unknown';
      // Review round 2 of PR #87 (A-R2-2): the time this window was last seen using the environment, before the Git step
      // (so a state recorded by this release is not older than it), for every release (also a kept one).
      const seenAt = new Date().toISOString();
      const markSeenInUse = deps.markSeenInUse;
      seen =
        markSeenInUse === undefined
          ? undefined
          : Promise.resolve()
              .then(() => markSeenInUse(environment, seenAt))
              .then(
                () => undefined,
                (error: unknown) => deps.logger.info(`The last use of ${environment.repository} could not be recorded: ${errorMessage(error)}`),
              );
      const settings = deps.settings();
      if (keptWhenClosed(keepFlagsOf(environment), settings)) return 'kept';
      if (await deps.otherWindowUses(environment)) return 'inUse';
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
    } finally {
      // Review round 2 of PR #87 (A-R2-2): never rejects; waited for until shortly before the bound of the release, so a
      // slow registry never turns the outcome into 'failed'.
      const pending = seen;
      if (pending !== undefined) await within(Math.max(0, bounds.totalMs - (Date.now() - started) - SEEN_MARGIN_MS), () => pending);
    }
  });
  return outcome ?? 'failed';
}
