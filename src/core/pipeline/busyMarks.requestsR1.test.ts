// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #105 (B, mutation probes): `onReplaced` hears a copy of the replaced mark, never the object of the
// registry entry.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../ports';
import type { BusyMark, Environment } from '../types';
import { registryBusyMarks } from './busyMarks';

describe('review round 1 of PR #105 (B): onReplaced', () => {
  it('is called with a copy of the replaced mark', async () => {
    const old: BusyMark = { operation: 'create', since: new Date(0).toISOString(), pid: 200, windowId: 'w2' };
    const entry = { id: 'e1', busy: old } as Environment;
    // A registry that hands the mutator its own entry (no copy).
    const registry = { updateEnvironment: async (_id: string, mutator: (e: Environment) => void | Promise<void>) => (await mutator(entry), entry) };
    const marks = registryBusyMarks(registry, { owner: { windowId: 'w1', pid: 100 }, clock: { now: () => Date.parse('2026-10-04T12:00:00.000Z') }, isAlive: () => false, logger: silentLogger });
    const heard: BusyMark[] = [];
    await marks.mark('e1', 'create', (mark) => heard.push(mark));
    expect(heard).toEqual([{ operation: 'create', since: new Date(0).toISOString(), pid: 200, windowId: 'w2' }]);
    expect(heard[0]).not.toBe(old);
  });
});
