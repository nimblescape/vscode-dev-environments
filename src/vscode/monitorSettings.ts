// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, D1 and D2), review round 1 of 11H2 (A-L7, A-L2): the settings of the Session
// Monitor of an engine that extension.ts gives to an open (by the Docker host of the open) and to the repair of the
// heartbeats (by the Docker target): the image patterns of imageUpdates, the schedule of its background run
// (cacheUpdateSchedule), the time zone of this computer, and its mode: permanent on a remote engine (`remote`), on a
// local one only with stopLocalMonitorWhenIdle off. Pure apart from the getters it is given; no `vscode`.
import type { DockerTarget } from '../core/docker/dockerHost';
import { DEFAULT_CACHE_UPDATE_SCHEDULE, monitorRunsPermanently } from '../core/remoteMonitor/cacheSettings';
import type { MonitorSettings } from '../core/remoteMonitor/protocol';
import type { ExtensionSettings } from '../core/types';

export interface MonitorSettingsDeps {
  settings: () => Pick<ExtensionSettings, 'cacheUpdateSchedule' | 'stopLocalMonitorWhenIdle'>;
  /** The prefixes of imageUpdates that are used (imagePrefixesOf, with the warning of the patterns left out). */
  prefixes: () => string[];
  /** The time zone of this computer (usableTimeZone). */
  timeZone: () => string;
}

/** Plan step 11H2: the settings of the monitor for an engine that this computer reaches as a remote one or as the local one. */
export function monitorSettingsFor(remote: boolean, deps: MonitorSettingsDeps): MonitorSettings {
  const settings = deps.settings();
  const permanent = monitorRunsPermanently(remote, settings.stopLocalMonitorWhenIdle);
  return {
    prefixes: deps.prefixes(),
    schedule: settings.cacheUpdateSchedule ?? DEFAULT_CACHE_UPDATE_SCHEDULE,
    timeZone: deps.timeZone(),
    permanent,
    // Review round 1 of 11H2 (A-L2): why it is permanent (part of its label).
    ...(permanent && remote ? { remote: true } : {}),
  };
}

/**
 * Plan step 11H2 (D1): the monitor settings of an open (its Docker host: empty for the local Docker, the SSH host
 * otherwise) and of the repair of a Docker target (`remote` or not).
 */
export function monitorSettingsOf(deps: MonitorSettingsDeps): { forOpen(dockerHost: string): MonitorSettings; forTarget(target: Pick<DockerTarget, 'kind'>): MonitorSettings } {
  return {
    forOpen: (dockerHost) => monitorSettingsFor(dockerHost !== '', deps),
    forTarget: (target) => monitorSettingsFor(target.kind === 'remote', deps),
  };
}
