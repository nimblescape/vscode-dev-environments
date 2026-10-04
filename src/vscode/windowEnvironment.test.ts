// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11C3 (A-R1-M2): the environment of the window at its activation, with the restore of a lost
// registry by the worker within WINDOW_RESTORE_TIMEOUT_MS, and the restore again after the build of the helper image.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { Environment } from '../core/types';
import { WINDOW_RESTORE_TIMEOUT_MS, findWindowEnvironment, restoreAfterPrebuild } from './windowEnvironment';

const ENTRY = { id: 'e1', containerName: 'devenv-acme-api-x' } as Environment;

function deps(options: { found?: Environment[]; needsRestore?: boolean; installed?: boolean; added?: number | Error } = {}) {
  const found = [...(options.found ?? [])];
  const errors: string[] = [];
  const all = {
    registry: { findByContainerName: vi.fn(async () => found.shift()) },
    needsRestore: async () => options.needsRestore ?? true,
    docker: { isInstalled: () => options.installed ?? true },
    service: {
      reconcileInWorker: vi.fn(async (_options: { passive: boolean; signal?: AbortSignal }) => {
        if (options.added instanceof Error) throw options.added;
        return options.added ?? 0;
      }),
    },
    logger: { ...silentLogger, error: (text: string) => errors.push(text) },
  };
  return { all, errors };
}

describe('the environment of the window at its activation (review round 1 of 11C3)', () => {
  it('the registry knows it: no restore', async () => {
    const { all } = deps({ found: [ENTRY] });
    expect(await findWindowEnvironment('devenv-acme-api-x', all)).toBe(ENTRY);
    expect(all.service.reconcileInWorker).not.toHaveBeenCalled();
  });

  it('a lost registry is restored by the worker, passively and within the time limit of the activation', async () => {
    const { all } = deps({ found: [undefined as unknown as Environment, ENTRY], added: 1 });
    expect(await findWindowEnvironment('devenv-acme-api-x', all)).toBe(ENTRY);
    const [options] = all.service.reconcileInWorker.mock.calls[0];
    expect(options.passive).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(WINDOW_RESTORE_TIMEOUT_MS).toBe(30_000);
  });

  it('nothing restored, a valid registry, or no Docker: no environment', async () => {
    expect(await findWindowEnvironment('c', deps({ added: 0 }).all)).toBeUndefined();
    const valid = deps({ needsRestore: false });
    expect(await findWindowEnvironment('c', valid.all)).toBeUndefined();
    expect(valid.all.service.reconcileInWorker).not.toHaveBeenCalled();
    const noDocker = deps({ installed: false });
    expect(await findWindowEnvironment('c', noDocker.all)).toBeUndefined();
    expect(noDocker.all.service.reconcileInWorker).not.toHaveBeenCalled();
  });

  it('a restore that fails or times out never fails the activation (logged)', async () => {
    const { all, errors } = deps({ added: new Error('The operation was aborted due to timeout') });
    expect(await findWindowEnvironment('c', all)).toBeUndefined();
    expect(errors).toEqual(['The environment of this window could not be found.']);
  });

  it('the restore runs again only after the helper image was built', async () => {
    for (const outcome of ['notDue', 'unsupported', 'dockerNotRunning', 'present', 'failed', 'cancelled'] as const) {
      const restore = vi.fn(async () => {});
      await restoreAfterPrebuild(outcome, restore);
      expect(restore, outcome).not.toHaveBeenCalled();
    }
    const restore = vi.fn(async () => {});
    await restoreAfterPrebuild('built', restore);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
