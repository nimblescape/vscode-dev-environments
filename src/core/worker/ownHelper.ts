// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b (section 3b of the plan: the helper image of an open is the worker's own image): what the worker reads
// of its own container, so that the batch helpers of its flows run from its image (by ID) with the same socket of the
// engine. Read from the engine (the inspect of the worker's container), never from a parameter. Pure; no I/O, no `vscode`.
import { HELPER_DOCKER_SOCKET } from '../names';
import type { HelperImageUse } from '../helper/helperImage';
import type { DockerEngine } from './dockerEngine';

/** The worker's own helper image and the source of its socket mount on the Docker host. */
export interface OwnHelper {
  image: HelperImageUse;
  socket: string;
}

/**
 * The OwnHelper of the inspect JSON of the worker's container: its image ID (`Image`), the reference it was started from
 * (`Config.Image`), and the source of the bind mount at HELPER_DOCKER_SOCKET. `undefined` when one of them is missing.
 */
export function ownHelperOf(inspect: unknown): OwnHelper | undefined {
  if (typeof inspect !== 'object' || inspect === null) return undefined;
  const value = inspect as { Image?: unknown; Config?: { Image?: unknown }; Mounts?: unknown };
  const id = value.Image;
  const tag = value.Config?.Image;
  if (typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(id) || typeof tag !== 'string' || tag === '') return undefined;
  const mounts = Array.isArray(value.Mounts) ? (value.Mounts as unknown[]) : [];
  const socket = mounts
    .map((mount) => mount as { Type?: unknown; Source?: unknown; Destination?: unknown })
    .find((mount) => mount.Type === 'bind' && mount.Destination === HELPER_DOCKER_SOCKET && typeof mount.Source === 'string' && mount.Source !== '')?.Source;
  if (typeof socket !== 'string') return undefined;
  return { image: { tag, id }, socket };
}

/**
 * The OwnHelper of the worker whose container is `container` (its host name, the short ID that Docker gives it). Throws
 * when the engine does not know it, when the container found is not the one of that ID (review round 1 of 11B3b, A-R1-1:
 * the engine also finds a container by a name, so one named like the ID is never taken for the worker), or when its
 * inspect lacks what is needed.
 */
export async function readOwnHelper(engine: Pick<DockerEngine, 'inspect'>, container: string, signal?: AbortSignal): Promise<OwnHelper> {
  if (!/^[0-9a-f]{12,64}$/.test(container)) throw new Error(`The host name ${container} of the worker is not the ID of its container.`);
  const inspect = await engine.inspect('container', container, signal);
  if (inspect === undefined) throw new Error(`The container ${container} of the worker is not known to the engine.`);
  const id = (inspect as { Id?: unknown }).Id;
  if (typeof id !== 'string' || !id.startsWith(container)) throw new Error(`The engine answered the container ${container} of the worker with another container.`);
  const own = ownHelperOf(inspect);
  if (own === undefined) throw new Error(`The image or the socket mount of the worker's container ${container} cannot be read.`);
  return own;
}
