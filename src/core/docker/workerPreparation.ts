// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR D (rule D1 of 2026-09-30): the scope of the Docker calls that check and make consistent the state that
// the worker needs before it can exist: the check whether the engine runs (ContainerAdapter.daemonStatus, so "Docker is
// not running" stays its own refusal) and the helper image (WorkspaceHelper: its check and build). They cannot go
// through the worker, which is opened from that image, so ContainerAdapter.run runs them directly, like the calls of the
// open of the worker (runDirect). Every other plain Docker call of an operation goes only through the worker. The lock
// of an environment (environmentLock.ts) still wins: under it, every plain call goes through its worker. No `vscode`.
import { AsyncLocalStorage } from 'async_hooks';

const preparing = new AsyncLocalStorage<true>();

/** Runs `fn` in the scope of the worker preparation (see the module comment). */
export function runPreparingWorker<T>(fn: () => Promise<T>): Promise<T> {
  return preparing.run(true, fn);
}

/** True within runPreparingWorker. */
export function preparingWorker(): boolean {
  return preparing.getStore() === true;
}
