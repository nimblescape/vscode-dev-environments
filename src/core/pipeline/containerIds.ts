// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F1: the comparison of container IDs, shared by the pipeline (pipelineRules re-exports it) and the window's
// memory of its containers (lifecycleMemory), without the rules of the pipeline. Pure; no `vscode`.

/** Plan step 11E4a: moved from ./environmentService. Docker and the Dev Container CLI name a container by its full ID or by a prefix of it. */
export function sameContainerId(a: string, b: string): boolean {
  return a !== '' && b !== '' && (a.startsWith(b) || b.startsWith(a));
}

/**
 * Review round 2 of PR #68: the same container. Two full IDs (64 hexadecimal digits) are compared exactly; only a short
 * one is compared as a prefix (sameContainerId), so that no ID that merely starts with another one matches.
 */
export function sameContainer(a: string, b: string): boolean {
  if (a === b) return true;
  const full = /^[0-9a-f]{64}$/;
  return full.test(a) !== full.test(b) && sameContainerId(a, b);
}
