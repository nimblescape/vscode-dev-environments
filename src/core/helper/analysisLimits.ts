// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 9 (S9-1, S9-2, S9-3): the bounds of what the extension host reads, keeps, and passes on of a
// configuration of a repository, before the analysis in the worker (configurationAnalysisRunner.ts) takes over. A
// configuration beyond them is refused as not supported with ANALYSIS_FAILED_ITEM ("too large or too complex"): real
// configurations stay far below them. Pure: no `vscode` import, no I/O.

/** The longest devcontainer.json (characters) that the extension reads (READ_FILES_SCRIPT reads at most one more). */
export const MAX_CONFIG_TEXT_LENGTH = 1024 * 1024;

/** The most services of a Docker Compose model. */
export const MAX_COMPOSE_SERVICES = 500;

/** The most mounts (`volumes` entries) of all services of a Docker Compose model together. */
export const MAX_COMPOSE_MOUNTS = 5000;

/**
 * Review round 10 (S10-1): the most entries of each keyed top-level map of a Docker Compose model (`volumes`,
 * `networks`, `configs`, `secrets`).
 */
export const MAX_COMPOSE_TOP_LEVEL_ENTRIES = 5000;

/** The most output (bytes) of a program that the extension keeps (NodeProcessRunner). */
export const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Review round 10 (S10-5): the most characters of the standard error output of a program that the extension keeps
 * (NodeProcessRunner): the end of it, for error texts and the checks for a missing object. All of it still streams to
 * `onStderr`.
 */
export const MAX_CAPTURED_STDERR_CHARACTERS = 1024 * 1024;

/**
 * The most characters of the texts of one analysis job (AnalysisJob) that are passed to its worker: the structured clone
 * of `postMessage` copies them in the extension host, before the worker's limits apply.
 */
export const MAX_ANALYSIS_JOB_CHARACTERS = 32 * 1024 * 1024;

/** The most image references whose image IDs the pipeline asks Docker about (imageIdItems). */
export const MAX_IMAGE_ID_REFERENCES = 1000;

/** The most references of one `docker image inspect` call. */
export const IMAGE_INSPECT_BATCH = 100;
