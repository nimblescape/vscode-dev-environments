// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F2: the kinds of the steps of the batch helper (batchSteps.ts), without the steps. No `vscode`.

/** The step kinds of the batch helper (each one is an operation of its ChannelServer). */
export const BATCH_STEP_KINDS = [
  'clone',
  'readFiles',
  'listConfigs',
  'readConfiguration',
  'build',
  'composeModel',
  'composeHash',
  'createFolders',
  'up',
  'runUserCommands',
  'gitFiles',
  'ownershipFix',
] as const;
export type BatchStepKind = (typeof BATCH_STEP_KINDS)[number];

export function isBatchStepKind(value: unknown): value is BatchStepKind {
  return typeof value === 'string' && (BATCH_STEP_KINDS as readonly string[]).includes(value);
}
