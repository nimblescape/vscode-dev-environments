// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11C3 (reviewer B, mutation probes): findWindowEnvironment waits WINDOW_RESTORE_TIMEOUT_MS, and reads
// the registry again only when the worker restored entries.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { Environment } from '../core/types';
import { WINDOW_RESTORE_TIMEOUT_MS, findWindowEnvironment, restoreAfterPrebuild } from './windowEnvironment';

const ENTRY = { id: 'e1', containerName: 'devenv-acme-api-x' } as Environment;

function deps(found: Array<Environment | undefined>, added: number) {
  return {
    registry: { findByContainerName: vi.fn(async () => found.shift()) },
    needsRestore: async () => true,
    docker: { isInstalled: () => true },
    service: { reconcileInWorker: vi.fn(async (_options: { passive: boolean; signal?: AbortSignal }) => added) },
    logger: silentLogger,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('findWindowEnvironment (review round 2 of 11C3, reviewer B)', () => {
  it('the signal of the restore times out after WINDOW_RESTORE_TIMEOUT_MS', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const all = deps([undefined, ENTRY], 1);
    expect(await findWindowEnvironment('devenv-acme-api-x', all)).toBe(ENTRY);
    expect(timeout).toHaveBeenCalledWith(WINDOW_RESTORE_TIMEOUT_MS);
    expect(all.service.reconcileInWorker.mock.calls[0][0].signal).toBe(timeout.mock.results[0].value);
  });

  // Review round 2 of 11C3 (A-R2-M1): changed, nothing added here still reads the registry again (another window may have
  // restored it first); the probe of reviewer B expected one read, the behaviour before that fix.
  it('nothing restored: the registry is read again and its entry found', async () => {
    const all = deps([undefined, ENTRY], 0);
    expect(await findWindowEnvironment('devenv-acme-api-x', all)).toBe(ENTRY);
    expect(all.registry.findByContainerName).toHaveBeenCalledTimes(2);
  });

  it('restoreAfterPrebuild waits for the restore, and fails with it', async () => {
    await expect(restoreAfterPrebuild('built', async () => Promise.reject(new Error('no Docker')))).rejects.toThrow('no Docker');
    let done = false;
    await restoreAfterPrebuild('built', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done = true;
    });
    expect(done).toBe(true);
  });
});
