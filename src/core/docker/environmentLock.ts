// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: the lock of an environment on the Docker host (taken in the worker, src/helperChannel/workerLock.ts;
// plan step 11I1, PR B1: the operation `lock` is gone) and the scope of an operation that holds it: the pipeline of the
// worker knows the environments whose lock it holds (holdsEnvironmentLock) and runs its volume steps in the batch helper
// of the lock (src/core/helper/batchScope.ts). Plan step 11I1, PR B2: no Docker call goes through the lock any more (the
// routing of ContainerAdapter is gone). The scope is re-entrant: an operation that holds the lock of an environment does
// not take it again. No `vscode`.
import { AsyncLocalStorage } from 'async_hooks';
import type { HelperBatchSession } from '../helperChannel/helperChannel';

/** A held lock of an environment (the worker's own, workerEnvironmentLock of src/helperChannel/workerLock.ts). */
export interface HeldEnvironmentLock {
  readonly environmentId: string;
  /**
   * Resolves with the reason when the lock was lost without `release`: the worker was lost or closed, or the lock
   * operation ended by itself (its backstop). Never rejects.
   */
  readonly lost: Promise<string>;
  /**
   * Plan step 6, PR B: a batch helper of the operation in the worker that holds the lock (workerBatchSession). Plan step
   * 6, PR C: the open pipeline runs its volume steps in it (src/core/helper/batchScope.ts).
   */
  batch?(p: { volume: string; image: string; socket: string }, signal?: AbortSignal): Promise<HelperBatchSession>;
  /** Lets go of the lock and resolves when the worker confirmed it, or the worker was lost (the kernel frees it). Never rejects. */
  release(): Promise<void>;
}

/**
 * The lock could not be taken. `busy`: another window or computer holds it (user decision D3: after the wait).
 * `unavailable`: no worker (it could not be opened, it reaches another engine, it does not know the lock), or the lock
 * failed in the worker (user decision D1: the state is not consistent; the operation is refused).
 */
export class EnvironmentLockError extends Error {
  constructor(
    readonly kind: 'busy' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'EnvironmentLockError';
  }
}

interface LockScope {
  readonly environmentIds: ReadonlySet<string>;
  active: boolean;
}

const lockScopes = new AsyncLocalStorage<LockScope>();

/** The scope of the held lock of the running operation, if any (an ended scope counts as none). */
function currentScope(): LockScope | undefined {
  const scope = lockScopes.getStore();
  return scope?.active ? scope : undefined;
}

/** True while the running operation holds the lock of `environmentId`. */
export function holdsEnvironmentLock(environmentId: string): boolean {
  return currentScope()?.environmentIds.has(environmentId) === true;
}

/** Runs `fn` in the scope of the held `lock` (see the module comment). The caller releases the lock after it. */
export async function runWithEnvironmentLock<T>(lock: HeldEnvironmentLock, fn: () => Promise<T>): Promise<T> {
  const parent = currentScope();
  const scope: LockScope = {
    environmentIds: new Set([...(parent?.environmentIds ?? []), lock.environmentId]),
    active: true,
  };
  try {
    return await lockScopes.run(scope, fn);
  } finally {
    scope.active = false;
  }
}
