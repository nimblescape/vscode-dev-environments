// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #105 (B, mutation probes): the bounds, the own-mark test, the remembered marks, the operation
// without a Docker host and the detailed allowances of the registry writes of the open.
import { describe, expect, it } from 'vitest';
import { registryBusyMarks, type BusyMarkView } from '../pipeline/busyMarks';
import { silentLogger } from '../ports';
import type { BusyMark, Environment, GitHubAccount, WindowStatus } from '../types';
import type { HostCall, HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';
import { checkedBusyMark, checkedLifecycleChange, requestOpenRecords, type OpenRequestScope } from './openRequests';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const HOST = 'ssh://box';
const OWNER = { windowId: 'w1', pid: 100 };
const ACCOUNT: GitHubAccount = { id: '42', login: 'octo' };
const CONTAINER = 'c'.repeat(12);
const ALL: readonly HostCall[] = ['record markBusy', 'record createMark', 'record stepMark', 'record ownerLogin', 'record lifecycleMark', 'record openFinished'];
const FINISH = { remoteWorkspaceFolder: '/workspaces/api' };
const own = (fields: Partial<BusyMark> = {}): BusyMark => ({ operation: 'create', since: new Date(NOW - 60_000).toISOString(), pid: OWNER.pid, windowId: OWNER.windowId, ...fields });
const mark = (fields: Partial<BusyMark> = {}): BusyMark => ({ operation: 'update', since: '2026-10-04T11:00:00.000Z', pid: 200, windowId: 'w2', ...fields });

function setup(fields: Partial<Environment> = {}, options: { allowed?: readonly HostCall[]; scope?: { environmentId?: string; dockerHost?: string }; windowStatuses?: WindowStatus[] } = {}) {
  const entries = new Map<string, Environment>([[ID, { id: ID, repository: 'acme/api', owner: { id: ACCOUNT.id, login: 'old' }, dockerHost: HOST, lastUsedAt: '2020-01-01T00:00:00.000Z', ...fields } as Environment]]);
  const registry = {
    // Plan step 11E4c: requestOpenRecords takes `update` too (createEnvironment, dropCreated, configuration); not used here.
    update: async () => {
      throw new Error('The registry file is not used by these requests.');
    },
    updateEnvironment: async (id: string, mutator: (entry: Environment) => void | Promise<void>) => {
      const found = entries.get(id);
      if (!found) return undefined;
      const copy = structuredClone(found);
      await mutator(copy);
      entries.set(id, copy);
      return structuredClone(copy);
    },
  };
  const view: BusyMarkView = { owner: OWNER, clock: { now: () => NOW }, isAlive: () => true, windowStatuses: async () => options.windowStatuses ?? [], logger: silentLogger };
  const busyMarks = registryBusyMarks(registry, view);
  const open = (scope: OpenRequestScope | undefined) => {
    if (scope === undefined) throw new Error('no scope');
    return requestOpenRecords(registry, view, { account: ACCOUNT, dockerHost: scope.dockerHost });
  };
  const records = {
    markBusy: (id: string, operation: BusyMark['operation'], onReplaced?: (m: BusyMark) => void) => busyMarks.mark(id, operation, onReplaced),
    createMark: (id: string, kind: 'ended' | 'previous', previous: BusyMark | undefined, scope?: OpenRequestScope) => open(scope).createMark(id, kind, previous),
    takeStepMark: (id: string, operation: BusyMark['operation'], scope?: OpenRequestScope) => open(scope).takeStepMark(id, operation),
    releaseStepMark: (id: string, m: BusyMark, scope?: OpenRequestScope) => open(scope).releaseStepMark(id, m),
    ownerLogin: (id: string, scope?: OpenRequestScope) => open(scope).ownerLogin(id),
    lifecycleMark: (id: string, change: 'clear' | { set: string }, scope?: OpenRequestScope) => open(scope).lifecycleMark(id, change),
    openFinished: (id: string, finish: typeof FINISH, scope?: OpenRequestScope) => open(scope).openFinished(id, finish),
  };
  const host = { questions: {}, state: {}, records, secrets: {}, connect: {} } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, options.allowed ?? ALL, options.scope ?? { environmentId: ID, dockerHost: HOST });
  const signal = new AbortController().signal;
  const ask = (call: string, ...args: unknown[]) => handler('record', { call, args }, signal).then((answer) => answer.value);
  return { ask, entry: () => entries.get(ID), registry, view };
}

describe('review round 1 of PR #105 (B): the checks of the registry writes of the open', () => {
  it('checkedBusyMark: a window ID of at most 256 characters, a positive whole pid, no control character, a rebuilt object', () => {
    expect(checkedBusyMark(mark({ windowId: 'w'.repeat(256) }))).toEqual(mark({ windowId: 'w'.repeat(256) }));
    for (const fields of [{ windowId: 'w'.repeat(257) }, { windowId: '' }, { windowId: 'w\u007f' }, { pid: 0 }, { pid: 1.5 }, { pid: -1 }]) {
      expect(() => checkedBusyMark(mark(fields))).toThrow('busy mark');
    }
    const sent = mark();
    expect(checkedBusyMark(sent)).not.toBe(sent);
  });

  it('checkedLifecycleChange: a new object, never the one of the request', () => {
    const sent = { set: CONTAINER };
    expect(checkedLifecycleChange(sent)).toEqual(sent);
    expect(checkedLifecycleChange(sent)).not.toBe(sent);
  });

  it('openFinished: a Git state time of at most 64 characters, a folder without DEL', async () => {
    // A valid time of 65 characters (Date.parse takes the long fraction).
    const recordedAt = `2026-10-04T12:00:00.${'0'.repeat(44)}Z`;
    expect(recordedAt).toHaveLength(65);
    expect(Number.isFinite(Date.parse(recordedAt))).toBe(true);
    const gitSummary = { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt };
    for (const finish of [{ ...FINISH, gitSummary }, { remoteWorkspaceFolder: '/workspaces/api\u007f' }]) {
      const { ask, entry } = setup();
      const before = structuredClone(entry());
      await expect(ask('openFinished', ID, finish)).rejects.toMatchObject({ code: 'invalid' });
      expect(entry()).toEqual(before);
    }
  });

  it('openFinished: the container whose lifecycle commands ran clears its mark', async () => {
    const { ask } = setup({ lifecycleIncomplete: CONTAINER });
    expect(await ask('openFinished', ID, { ...FINISH, lifecycleRanFor: CONTAINER })).not.toHaveProperty('lifecycleIncomplete');
  });

  it('a mark of this window ID but another pid is not one of this window', async () => {
    const foreign = own({ operation: 'update', pid: 999 });
    const release = setup({ busy: foreign });
    await expect(release.ask('stepMark', ID, 'release', foreign)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('not one of this window') });
    expect(release.entry()?.busy).toEqual(foreign);
  });

  it('createMark ended over an update mark of another window leaves it, without a refusal', async () => {
    const { ask, entry } = setup({ busy: mark() });
    expect(await ask('createMark', ID, 'ended')).toMatchObject({ busy: mark() });
    expect(entry()?.busy).toEqual(mark());
  });

  it('the handler remembers the last 8 replaced marks, no more', async () => {
    const interrupted = mark({ operation: 'create', since: new Date(0).toISOString() });
    // 1 + 7 markBusy: the first replaced mark is still among the last 8.
    const kept = setup({ busy: interrupted });
    for (let i = 0; i < 8; i++) await kept.ask('markBusy', ID, 'create');
    expect(await kept.ask('createMark', ID, 'previous', interrupted)).toMatchObject({ busy: interrupted });
    // 1 + 8 markBusy: it is not.
    const dropped = setup({ busy: interrupted });
    for (let i = 0; i < 9; i++) await dropped.ask('markBusy', ID, 'create');
    // Adapted to A-L1 of the same round (a mark not remembered ends the create mark of this window; before: refused).
    const busy = dropped.entry()!.busy!;
    expect(await dropped.ask('createMark', ID, 'previous', interrupted)).toMatchObject({ busy: { ...busy, since: new Date(0).toISOString() } });
  });

  it('an operation without a Docker host writes nothing, not even on an entry of the local Docker', async () => {
    const { ask, entry } = setup({ dockerHost: undefined, busy: own() }, { scope: { environmentId: ID } });
    const before = structuredClone(entry());
    await expect(ask('createMark', ID, 'ended')).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('names no Docker host') });
    await expect(ask('ownerLogin', ID)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('names no Docker host') });
    expect(entry()).toEqual(before);
  });

  it('an allowance can name the kind of a create mark or a step mark', async () => {
    const ended = setup({ busy: own() }, { allowed: ['record createMark.ended'] });
    await expect(ended.ask('createMark', ID, 'previous')).rejects.toMatchObject({ code: 'invalid' });
    expect(await ended.ask('createMark', ID, 'ended')).toMatchObject({ id: ID });
    const take = setup({}, { allowed: ['record stepMark.take'] });
    await expect(take.ask('stepMark', ID, 'release', own())).rejects.toMatchObject({ code: 'invalid' });
    expect(await take.ask('stepMark', ID, 'take', 'update')).toMatchObject({ mark: { operation: 'update' } });
  });
});
