// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 1 of PR #111 (mutation probes): the image settings and list of an open reach the Session Monitor of
// the worker's services (B1-57: workerServiceDeps passes monitorImages on; without it there are none).
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { workerServiceDeps, type WorkerServicesDeps } from './workerServices';

const TARGET = { kind: 'local', host: undefined, endpoint: undefined } as never;

const deps = (overrides: Partial<WorkerServicesDeps>) =>
  workerServiceDeps({
    host: {} as HostSide,
    engine: unusedEngine(),
    secretOf: () => undefined,
    forgetSecret: () => undefined,
    logger: silentLogger,
    ownHelper: { image: { tag: 'devenv-helper:abc', id: `sha256:${'e'.repeat(64)}` }, socket: '/s.sock' },
    dockerHost: '',
    owner: { windowId: 'w', pid: 1 },
    environmentLock: async () => Promise.reject(new Error('no lock in this test')),
    ...overrides,
  });

describe("the images of an open in the worker's services (review B, round 1 of PR #111)", () => {
  it('B1-57: the monitorImages of the operation are the Session Monitor\'s images, with the signal of the pipeline', async () => {
    const monitorImages = vi.fn(async (_signal: AbortSignal | undefined) => {});
    const signal = new AbortController().signal;
    await deps({ monitorImages }).sessionMonitor!.images!(TARGET, signal);
    expect(monitorImages).toHaveBeenCalledWith(signal);
    expect(deps({}).sessionMonitor!.images).toBeUndefined();
  });
});
