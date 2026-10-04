// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11C2a (mutation tests, B-R1): clear removes only the mark of this window and its process.

// Plan step 11C2a (decision of 2026-10-04): the busy marks of the window that runs an operation, decided with its own
// clock and view of the windows under the registry lock (registryBusyMarks), for its own pipeline and for the requests
// of the worker alike.
import { describe, expect, it } from 'vitest';
import { BUSY_MARK_MAX_AGE_MS } from '../busy';
import { silentLogger } from '../ports';
import type { BusyMark, Environment, WindowStatus } from '../types';
import { registryBusyMarks, type BusyMarkView } from './busyMarks';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const OWNER = { windowId: 'window-1', pid: 100 };

function setup(busy?: BusyMark, view: Partial<BusyMarkView> = {}) {
  const entries = new Map<string, Environment>([[ID, { id: ID, repository: 'acme/api', ...(busy ? { busy } : {}) } as unknown as Environment]]);
  const registry = {
    updateEnvironment: async (id: string, mutator: (entry: Environment) => void) => {
      const entry = entries.get(id);
      if (!entry) return undefined;
      const copy = structuredClone(entry);
      mutator(copy);
      entries.set(id, copy);
      return copy;
    },
  };
  const marks = registryBusyMarks(registry, { owner: OWNER, clock: { now: () => NOW }, isAlive: () => true, logger: silentLogger, ...view });
  return { marks, entry: () => entries.get(ID) };
}

const other = (fields: Partial<BusyMark> = {}): BusyMark => ({ operation: 'update', since: new Date(NOW - 60_000).toISOString(), pid: 200, windowId: 'window-2', ...fields });


describe('clear keeps every mark that is not exactly this window and process (review round 1 of 11C2a, B-R1 B4, B5)', () => {
  it('keeps a mark of this window id with another process, and of this process with another window id', async () => {
    for (const busy of [other({ windowId: OWNER.windowId }), other({ pid: OWNER.pid })]) {
      const { marks, entry } = setup(busy);
      await marks.clear(ID);
      expect(entry()?.busy, JSON.stringify(busy)).toEqual(busy);
    }
  });
});
