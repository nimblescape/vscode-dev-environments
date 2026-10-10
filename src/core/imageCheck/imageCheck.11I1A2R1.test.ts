// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #117 (plan step 11I1, PR A2), reviewer B: decision D1 drops the Docker scenario of a registry that
// never answers (the 5 s of NFR-08, 4900..5500 ms). The pipeline (in the worker) calls ImageChecker.check without
// `timeoutMs`, so the limit is the default IMAGE_CHECK_TIMEOUT_MS; every unit test passed its own timeoutMs, so a changed
// or dropped default was caught by no test. Probe: the default limit holds, also when the request ignores the abort.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpTransport } from '../http';
import { ImageChecker } from './imageCheck';
import { IMAGE_CHECK_TIMEOUT_MS, RegistryClient } from './registryClient';

const hanging: HttpTransport = { request: () => new Promise(() => {}) };

describe('ImageChecker without timeoutMs (the call of the pipeline)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('NFR-08: the limit is 5 s; a registry that never answers is unreachable after it, not before', async () => {
    expect(IMAGE_CHECK_TIMEOUT_MS).toBe(5000);
    vi.useFakeTimers();
    const checker = new ImageChecker(new RegistryClient(hanging, async () => undefined, undefined, { credentialsTimeoutMs: 100 }));
    let outcome: unknown;
    void checker.check({ images: ['registry.example.com/team/app:1'], features: [] }).then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(4900);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(outcome).toEqual({ status: 'unreachable', registries: ['registry.example.com'] });
  });

  it('the pipeline passes no own limit: environmentService calls check with the signal only', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../pipeline/environmentService.ts'), 'utf8');
    const calls = source.match(/imageChecker\.check\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toMatch(/timeoutMs/);
  });
});
