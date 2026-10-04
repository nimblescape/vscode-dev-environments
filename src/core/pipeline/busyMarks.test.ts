// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

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

describe('the busy marks of the window that runs the operation (plan step 11C2a)', () => {
  it('sets the mark of this window with its clock, and clears only its own', async () => {
    const { marks, entry } = setup();
    const result = await marks.mark(ID, 'delete');
    const mark = { operation: 'delete', since: new Date(NOW).toISOString(), pid: OWNER.pid, windowId: OWNER.windowId };
    expect(result).toEqual({ environment: expect.objectContaining({ id: ID, busy: mark }) });
    expect(entry()?.busy).toEqual(mark);
    await marks.clear(ID);
    expect(entry()?.busy).toBeUndefined();
  });

  it('keeps the live mark of another window, answers it as the conflict, and never clears it', async () => {
    const { marks, entry } = setup(other());
    expect(await marks.mark(ID, 'delete')).toEqual({ conflict: other() });
    expect(entry()?.busy).toEqual(other());
    await marks.clear(ID);
    expect(entry()?.busy).toEqual(other());
  });

  it('takes over a mark that is not live: an ended process, older than 6 hours, a window without a recent status file', async () => {
    expect(await setup(other(), { isAlive: (pid) => pid !== 200 }).marks.mark(ID, 'delete')).toMatchObject({ environment: { busy: { pid: OWNER.pid } } });
    expect(await setup(other({ since: new Date(NOW - BUSY_MARK_MAX_AGE_MS - 1).toISOString() })).marks.mark(ID, 'delete')).toMatchObject({ environment: { busy: { pid: OWNER.pid } } });
    const statuses: WindowStatus[] = [];
    expect(await setup(other(), { windowStatuses: async () => statuses }).marks.mark(ID, 'delete')).toMatchObject({ environment: { busy: { pid: OWNER.pid } } });
    // A window status file that cannot be read keeps the rule without it (logged).
    const lines: string[] = [];
    const unreadable = setup(other(), { windowStatuses: async () => Promise.reject(new Error('EACCES')), logger: { ...silentLogger, warn: (text: string) => lines.push(text) } });
    expect(await unreadable.marks.mark(ID, 'delete')).toEqual({ conflict: other() });
    expect(lines).toEqual(['The window status files could not be read: EACCES']);
  });

  it('a mark of the same process (an earlier activation of this window) never keeps it; this window marks again', async () => {
    expect(await setup(other({ pid: OWNER.pid })).marks.mark(ID, 'rebuild')).toMatchObject({ environment: { busy: { operation: 'rebuild', windowId: OWNER.windowId } } });
    expect(await setup({ ...other(), pid: OWNER.pid, windowId: OWNER.windowId }).marks.mark(ID, 'delete')).toMatchObject({ environment: { busy: { operation: 'delete' } } });
  });

  it('an environment that is not in the registry is undefined', async () => {
    const { marks } = setup();
    expect(await marks.mark('6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b', 'delete')).toBeUndefined();
    await expect(marks.clear('6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b')).resolves.toBeUndefined();
  });
});

// Plan step 11E4b: the mark that a new mark replaced, which the extension remembers for `record createMark` `previous`.
describe('the mark that a busy mark replaced (plan step 11E4b)', () => {
  it('is heard once the new mark is written; nothing for no mark, a conflict or a missing entry', async () => {
    const heard: BusyMark[] = [];
    const listen = (mark: BusyMark) => void heard.push(mark);
    const ended = other({ since: new Date(NOW - BUSY_MARK_MAX_AGE_MS - 1).toISOString() });
    await setup(ended).marks.mark(ID, 'create', listen);
    expect(heard).toEqual([ended]);
    await setup().marks.mark(ID, 'create', listen);
    await setup(other()).marks.mark(ID, 'create', listen);
    await setup().marks.mark('6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b', 'create', listen);
    expect(heard).toEqual([ended]);
  });
});
