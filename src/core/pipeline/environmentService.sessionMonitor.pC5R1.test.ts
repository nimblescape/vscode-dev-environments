// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup C5 (plan step 11J, A11), review B: a probe of the narrowed port that the tests of the PR left
// open: the open gives `images` of the Session Monitor the signal of its run (the one its ensure gets), so a cancel of the
// open also ends the sending of the image list.
import { afterEach, describe, expect, it } from 'vitest';
import type { EnvironmentSessionMonitor } from './environmentPorts';
import { ENV_ID, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';

let h: Harness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

describe('the Session Monitor in the open pipeline: images (review round 1 of cleanup C5, B)', () => {
  it('gets the signal of the run, as the ensure does', async () => {
    const ensureSignals: (AbortSignal | undefined)[] = [];
    const imageSignals: (AbortSignal | undefined)[] = [];
    const sessionMonitor: EnvironmentSessionMonitor = {
      ensure: async (signal) => void ensureSignals.push(signal),
      heartbeat: async () => ({ ok: true }),
      forget: async () => undefined,
      images: async (signal) => void imageSignals.push(signal),
    };
    const created = createHarness({ dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }), sessionMonitor });
    h = created;
    await seedEnvironment(created, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await created.service.openEnvironment(ENV_ID, { progress: created.progress, signal: new AbortController().signal });
    expect(imageSignals).toHaveLength(1);
    expect(imageSignals[0]).toBeDefined();
    expect(imageSignals[0]).toBe(ensureSignals[0]);
  });
});
