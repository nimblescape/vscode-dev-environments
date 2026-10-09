// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Reviewer B, review round 2 of 11H3 (mutation testing): probes of the monitor's part changed in round 1 that no test
// pinned: the default volume of the lists in extensionRunDeps (REMOTE_MONITOR_STATE_DIR, never the store).
import { describe, expect, it } from 'vitest';
import { REMOTE_MONITOR_STATE_DIR } from '../core/remoteMonitor/protocol';
import { extensionRunDeps, type VscodeBackgroundDeps } from './background';

describe('the volume of the lists in the monitor (reviewer B, round 2 of 11H3)', () => {
  const vscode = (extra: Partial<VscodeBackgroundDeps>) =>
    ({ store: { root: '/a/store', transport: {} }, engine: { architecture: async () => 'x86_64' }, ...extra }) as unknown as VscodeBackgroundDeps;

  it('by default the monitor\'s own volume, never the store; a given folder otherwise', () => {
    const deps = extensionRunDeps(vscode({}), { log: () => undefined, now: () => 0 });
    expect(deps.stateDir).toBe(REMOTE_MONITOR_STATE_DIR);
    expect(deps.stateDir).not.toBe(deps.root);
    expect(extensionRunDeps(vscode({ extensionStateDir: '/a/state' }), { log: () => undefined, now: () => 0 }).stateDir).toBe('/a/state');
  });
});
