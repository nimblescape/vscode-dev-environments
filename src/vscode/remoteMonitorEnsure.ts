// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The `ensure` of the Session Monitor on a remote Docker host for the EnvironmentService (extension.ts), review round 2
// of PR #64 (B-M9): in a module of its own, so a test sees that it passes the image reference of a previous helper on.
import { DOCKER_SOCKET } from '../core/helper/workspaceHelper';
import type { EnvironmentRemoteMonitor } from '../core/pipeline/environmentService';
import type { RemoteSessionMonitor } from '../core/remoteMonitor/remoteSessionMonitor';

/**
 * @param monitor The Session Monitor of the remote host.
 * @param rootlessSocket The recorded socket of a rootless engine on the host (RemoteDockerState.rootlessSocket); without
 *   one, the helper mounts DOCKER_SOCKET, as the workspace helper does there.
 */
export function remoteMonitorEnsure(
  monitor: Pick<RemoteSessionMonitor, 'ensure'>,
  rootlessSocket: (host: string) => Promise<string | undefined>,
): EnvironmentRemoteMonitor['ensure'] {
  // Review round 1 of PR #64 (S1), review round 3 of PR #64 (P2): `helperImage`, the checked image ID of the helper image of
  // the open (current or previous), is the image of `docker run`.
  return async (host, helperTag, signal, helperImage) =>
    monitor.ensure(helperTag, (await rootlessSocket(host)) ?? DOCKER_SOCKET, signal, helperImage);
}
