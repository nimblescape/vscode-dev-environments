// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E4d (decision of 2026-09-29: the window remembers it): the containers whose lifecycle commands did not run
// and whose mark (Environment.lifecycleIncomplete) could not be recorded (review round 4 of PR #68, B-R4-2). The memory is
// the window's: the pipeline of the window uses it directly, the pipeline of the worker through the requests of its
// operation (`local unrecordedLifecycle`, `record rememberLifecycle`, `record forgetLifecycle`). Pure; no `vscode`.
import { sameContainer } from './pipelineRules';

export interface LifecycleMemory {
  /** The container of the environment that the window remembers, if any. */
  get(environmentId: string): Promise<string | undefined>;
  /** Remembers `containerId` for the environment (it replaces the one remembered before). */
  remember(environmentId: string, containerId: string): Promise<void>;
  /** Forgets the container of the environment when it is `containerId` (sameContainer). */
  forget(environmentId: string, containerId: string): Promise<void>;
}

/** The memory of one window, for the lifetime of its extension host. */
export function windowLifecycleMemory(): LifecycleMemory {
  const remembered = new Map<string, string>();
  return {
    get: async (environmentId) => remembered.get(environmentId),
    remember: async (environmentId, containerId) => void remembered.set(environmentId, containerId),
    forget: async (environmentId, containerId) => {
      const known = remembered.get(environmentId);
      if (known !== undefined && sameContainer(known, containerId)) remembered.delete(environmentId);
    },
  };
}
