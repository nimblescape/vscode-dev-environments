// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: the lock of an environment on the Docker host (the operation `lock` of the worker, protocol.ts) and
// the scope of an operation that holds it. While a lock is held, the plain Docker calls of the operation
// (isRoutableDockerCall) go only through the worker that holds it (ContainerAdapter.run), never directly: when that worker
// is lost, the lock is gone with it, and the calls fail instead of going on without the lock. Every call after the loss
// fails, whatever its kind. The scope is re-entrant: an operation that holds the lock of an environment does not take it
// again. No `vscode`.
import { AsyncLocalStorage } from 'async_hooks';
import type { RunOptions, RunResult } from '../ports';

/** A held lock of an environment (HelperChannel.lock). */
export interface HeldEnvironmentLock {
  readonly environmentId: string;
  /**
   * Resolves with the reason when the lock was lost without `release`: the worker was lost or closed, or the lock
   * operation ended by itself (its backstop). Never rejects.
   */
  readonly lost: Promise<string>;
  /** One plain Docker call through the worker that holds the lock. Rejects when it was not sent or its outcome is not known. */
  docker(args: readonly string[], options: Pick<RunOptions, 'timeoutMs' | 'signal'>): Promise<RunResult>;
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
  readonly lock: HeldEnvironmentLock;
  readonly parent: LockScope | undefined;
  lostReason: string | undefined;
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

/** The held lock of the running operation: its worker, and why a lock of the scope was lost (undefined while all hold). */
export function heldEnvironmentLock(): { lock: HeldEnvironmentLock; lostReason: () => string | undefined } | undefined {
  const scope = currentScope();
  if (scope === undefined) return undefined;
  return {
    lock: scope.lock,
    lostReason: () => {
      for (let item: LockScope | undefined = scope; item !== undefined; item = item.parent) {
        if (item.lostReason !== undefined) return item.lostReason;
      }
      return undefined;
    },
  };
}

/** Runs `fn` in the scope of the held `lock` (see the module comment). The caller releases the lock after it. */
export async function runWithEnvironmentLock<T>(lock: HeldEnvironmentLock, fn: () => Promise<T>): Promise<T> {
  const parent = currentScope();
  const scope: LockScope = {
    environmentIds: new Set([...(parent?.environmentIds ?? []), lock.environmentId]),
    lock,
    parent,
    lostReason: undefined,
    active: true,
  };
  void lock.lost.then((reason) => {
    scope.lostReason = reason;
  });
  try {
    return await lockScopes.run(scope, fn);
  } finally {
    scope.active = false;
  }
}
