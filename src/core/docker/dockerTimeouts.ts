// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I (PR D): the time limits of Docker calls that the Docker CLI of the bootstrap (bootstrapDocker.ts) and
// the worker's Docker (engineDocker.ts, the workspace helper) share, apart from both, so that the worker does not depend
// on the bootstrap module for them. No I/O.

/** Time limit of `docker info` (the engine can take some seconds to leave the Resource Saver mode). */
export const DOCKER_INFO_TIMEOUT_MS = 20_000;
/** Time limit of short Docker calls (queries, stop, remove), so that a hanging engine does not block forever. */
export const DOCKER_QUERY_TIMEOUT_MS = 60_000;
