// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The `ensure` of the Session Monitor container for the EnvironmentService (extension.ts), review round 2 of PR #64
// (B-M9): in a module of its own, so a test sees that it passes the image ID of the helper image of the open on. Plan
// step 8, PR A: on every engine, local and remote, and a failure rejects (the open is refused, user decision Q3 of
// 2026-10-02).
import type { DockerTarget } from '../core/docker/dockerHost';
import type { EnvironmentSessionMonitor } from '../core/pipeline/environmentService';
import type { RemoteSessionMonitor } from '../core/remoteMonitor/remoteSessionMonitor';

/**
 * @param monitor The Session Monitor of the engine of the operation.
 * @param socketPath The source of the socket mount on the host of the engine, as the workspace helper mounts it there
 *   (the recorded socket of a rootless remote engine, else /var/run/docker.sock; on the local Docker the socket of its
 *   endpoint).
 */
export function sessionMonitorEnsure(
  monitor: Pick<RemoteSessionMonitor, 'ensureOrThrow'>,
  socketPath: (target: Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>) => Promise<string>,
): EnvironmentSessionMonitor['ensure'] {
  // Review round 1 of PR #64 (S1), review round 3 of PR #64 (P2): `helperImage`, the checked image ID of the helper image of
  // the open, is the image of `docker run`.
  return async (target, helperTag, signal, helperImage) => monitor.ensureOrThrow(helperTag, await socketPath(target), signal, helperImage);
}
