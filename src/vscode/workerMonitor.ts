// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D1 (decision of 2026-10-03, "every remote action is a worker operation"): the calls of this window to the
// Session Monitor of an engine, as operations of the worker of that engine: the heartbeats (`heartbeat`), the image
// settings and list (`monitorSettings`), the check that the container of an environment exists there (`windowState`),
// and the Git state of a release (`recordGitState`). Before, a `docker exec` through the relay, a direct `docker exec -i`,
// and a `docker container inspect`. No `vscode` here; never throws, except the Git state (its caller bounds and logs it).
import type { DockerTarget } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import {
  OP_HEARTBEAT,
  OP_MONITOR_SETTINGS,
  OP_RECORD_GIT_STATE,
  OP_WINDOW_STATE,
  parseHeartbeatValue,
  parseMonitorSettingsValue,
  parseRecordGitStateParams,
  parseRecordGitStateValue,
  parseWindowStateParams,
  parseWindowStateValue,
} from '../core/helperChannel/protocol';
import type { Logger } from '../core/ports';
import type { HeartbeatInput, ImageSettings } from '../core/remoteMonitor/protocol';
import type { HeartbeatSendResult } from '../core/session/windowHeartbeats';
import type { Environment } from '../core/types';

/** A flow in the worker of `target` (extensionFlow with its target). */
export type TargetFlow = (op: string, params: unknown, options: { target: DockerTarget; signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>;

/** The longest heartbeat or monitor command in the worker: its `docker exec` (20 s) and the way there. */
export const MONITOR_FLOW_TIMEOUT_MS = 30_000;

export interface WorkerMonitorDeps {
  flow: TargetFlow;
  /** The window that sends the operations (for `recordGitState`). */
  owner: () => { windowId: string; pid: number };
  logger: Logger;
}

export function workerMonitor(deps: WorkerMonitorDeps) {
  const { flow, logger } = deps;
  return {
    /** One heartbeat on the engine `target` (WindowHeartbeatsDeps.send). */
    async heartbeat(target: DockerTarget, input: HeartbeatInput, signal?: AbortSignal): Promise<HeartbeatSendResult> {
      try {
        const value = parseHeartbeatValue(await flow(OP_HEARTBEAT, { heartbeat: input }, { target, timeoutMs: MONITOR_FLOW_TIMEOUT_MS, ...(signal ? { signal } : {}) }));
        if (value === undefined) return { ok: false, missing: false, detail: 'the worker answered the heartbeat with an invalid value' };
        return value;
      } catch (error) {
        return { ok: false, missing: false, detail: errorMessage(error) };
      }
    },

    /** The image settings (`settings`) or the image list (`repositories`) for the monitor of `target`; true when it took them. */
    async monitorSettings(target: DockerTarget, params: { settings: ImageSettings } | { repositories: string[] }): Promise<boolean> {
      const what = 'settings' in params ? 'The image settings' : 'The image list';
      try {
        const value = parseMonitorSettingsValue(await flow(OP_MONITOR_SETTINGS, params, { target, timeoutMs: MONITOR_FLOW_TIMEOUT_MS }));
        if (value === undefined) throw new Error('the worker answered with an invalid value');
        return value.sent;
      } catch (error) {
        logger.warn(`${what} could not be given to the Session Monitor: ${errorMessage(error)}`);
        return false;
      }
    },

    /**
     * Whether the container of `environment` exists on `target` (WindowHeartbeatsDeps.containerExists); false when it does
     * not or cannot be checked.
     */
    async containerExists(target: DockerTarget, environment: Environment, signal?: AbortSignal): Promise<boolean> {
      try {
        const params = parseWindowStateParams({ environmentId: environment.id, containerName: environment.containerName, checks: 'off' });
        if (params === undefined) throw new Error('its parameters are beyond the checks of the worker');
        const value = parseWindowStateValue(await flow(OP_WINDOW_STATE, params, { target, timeoutMs: MONITOR_FLOW_TIMEOUT_MS, ...(signal ? { signal } : {}) }));
        if (value === undefined) throw new Error('the worker answered with an invalid value');
        return value.state !== 'missing';
      } catch (error) {
        logger.info(`The container of ${environment.repository} could not be checked on ${target.kind === 'local' ? 'the local Docker' : target.host}: ${errorMessage(error)}`);
        return false;
      }
    },

    /** Records the Git state of `environment` (the release of this window), by the worker of `target`. */
    async recordGitState(target: DockerTarget, environment: Environment, signal?: AbortSignal): Promise<boolean> {
      const params = parseRecordGitStateParams({ environmentId: environment.id, dockerHost: target.host, owner: deps.owner() });
      if (params === undefined) throw new Error('The Git state of the release cannot be sent to the worker.');
      const value = parseRecordGitStateValue(await flow(OP_RECORD_GIT_STATE, params, { target, timeoutMs: MONITOR_FLOW_TIMEOUT_MS, ...(signal ? { signal } : {}) }));
      if (value === undefined) throw new Error('The worker answered the Git state of the release with an invalid value.');
      return value.recorded;
    },
  };
}

export type WorkerMonitor = ReturnType<typeof workerMonitor>;
