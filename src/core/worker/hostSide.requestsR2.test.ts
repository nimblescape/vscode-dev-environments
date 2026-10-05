// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #105 (B, mutation probes): the bounded fields of a remembered mark (busyMarkFields), the
// fallback of `createMark previous` to `ended` (its warning, its four-field match, a missing entry), the remote user as
// `docker exec -u` takes it, and the create-only guard of both kinds (A2-L1).
import { describe, expect, it } from 'vitest';
import { registryBusyMarks, type BusyMarkView } from '../pipeline/busyMarks';
import { endedMark } from '../pipeline/openRecords';
import { silentLogger, type Logger } from '../ports';
import type { BusyMark, Environment, GitHubAccount } from '../types';
import type { HostCall, HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';
import { busyMarkFields, requestOpenRecords, type OpenRequestScope } from './openRequests';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const HOST = 'ssh://box';
const OWNER = { windowId: 'w1', pid: 100 };
const ACCOUNT: GitHubAccount = { id: '42', login: 'octo' };
const ALL: readonly HostCall[] = ['record markBusy', 'record createMark', 'record stepMark', 'record ownerLogin', 'record lifecycleMark', 'record openFinished'];
const FINISH = { remoteWorkspaceFolder: '/workspaces/api' };
// A create mark of another window that is not live (no window status names it).
const interrupted = (fields: Partial<BusyMark> = {}): BusyMark => ({ operation: 'create', since: new Date(0).toISOString(), pid: 200, windowId: 'w2', ...fields });

function setup(fields: Partial<Environment> | null = {}, logger: Logger = silentLogger) {
  const entries = new Map<string, Environment>();
  if (fields !== null) entries.set(ID, { id: ID, repository: 'acme/api', owner: { id: ACCOUNT.id, login: 'old' }, dockerHost: HOST, lastUsedAt: '2020-01-01T00:00:00.000Z', ...fields } as Environment);
  const registry = {
    updateEnvironment: async (id: string, mutator: (entry: Environment) => void | Promise<void>) => {
      const found = entries.get(id);
      if (!found) return undefined;
      const copy = structuredClone(found);
      await mutator(copy);
      entries.set(id, copy);
      return structuredClone(copy);
    },
  };
  const view: BusyMarkView = { owner: OWNER, clock: { now: () => NOW }, isAlive: () => true, windowStatuses: async () => [], logger: silentLogger };
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
  const handler = hostSideHandler(host, logger, ALL, { environmentId: ID, dockerHost: HOST });
  const signal = new AbortController().signal;
  const ask = (call: string, ...args: unknown[]) => handler('record', { call, args }, signal).then((answer) => answer.value);
  return { ask, entry: () => entries.get(ID) };
}

describe('review round 2 of PR #105 (B): the registry writes of the open', () => {
  it('busyMarkFields: the four fields, each bounded and without a control character, any operation name, other keys left out', () => {
    const at = (fields: Record<string, unknown>) => busyMarkFields({ ...interrupted(), ...fields });
    expect(at({ extra: 1 })).toEqual(interrupted());
    expect(at({ operation: 'future' })).toEqual(interrupted({ operation: 'future' as BusyMark['operation'] }));
    expect(at({ windowId: 'w'.repeat(256) })).toEqual(interrupted({ windowId: 'w'.repeat(256) }));
    expect(at({ operation: 'o'.repeat(64) })).toMatchObject({ operation: 'o'.repeat(64) });
    expect(at({ since: 's'.repeat(64) })).toMatchObject({ since: 's'.repeat(64) });
    expect(at({ pid: 0 })).toMatchObject({ pid: 0 });
    for (const fields of [
      { windowId: 'w'.repeat(257) },
      { operation: 'o'.repeat(65) },
      { since: 's'.repeat(65) },
      { windowId: 'w\n' },
      { operation: 'create\u007f' },
      { since: 'then\u0000' },
      { windowId: 1 },
      { operation: undefined },
      { since: 0 },
      { pid: 1.5 },
      { pid: 2 ** 53 },
      { pid: '200' },
    ]) {
      expect(at(fields)).toBeUndefined();
    }
    for (const value of [null, undefined, 'x', 1, [interrupted()]]) expect(busyMarkFields(value)).toBeUndefined();
  });

  it('a remembered mark with a field beyond its bound is not found: the create mark of this window is ended', async () => {
    for (const fields of [{ windowId: 'w'.repeat(257) }, { operation: 'o'.repeat(65) as BusyMark['operation'] }, { since: 's'.repeat(65) }]) {
      const replaced = interrupted(fields);
      const { ask, entry } = setup({ busy: replaced });
      await ask('markBusy', ID, 'create');
      const ownMark = entry()!.busy!;
      expect(ownMark).toMatchObject(OWNER);
      expect(await ask('createMark', ID, 'previous', replaced)).toMatchObject({ busy: endedMark(ownMark) });
      expect(entry()?.busy).toEqual(endedMark(ownMark));
    }
  });

  it('a remembered mark with a window ID longer than a time is found and written back', async () => {
    const replaced = interrupted({ windowId: 'w'.repeat(200) });
    const { ask, entry } = setup({ busy: replaced });
    await ask('markBusy', ID, 'create');
    expect(await ask('createMark', ID, 'previous', replaced)).toMatchObject({ busy: replaced });
    expect(entry()?.busy).toEqual(replaced);
  });

  it('the remembered copy is written back as the registry held it, with a key of a newer version; never the sent fields', async () => {
    const held = { ...interrupted(), note: 'newer' } as BusyMark;
    const { ask, entry } = setup({ busy: held });
    await ask('markBusy', ID, 'create');
    expect(await ask('createMark', ID, 'previous', interrupted())).toMatchObject({ busy: held });
    expect(entry()?.busy).toEqual(held);
  });

  it('the match takes all four fields: another operation or window ID alone is not the remembered mark', async () => {
    for (const fields of [{ operation: 'update' as const }, { windowId: 'w3' }]) {
      const { ask, entry } = setup({ busy: interrupted() });
      await ask('markBusy', ID, 'create');
      const ownMark = entry()!.busy!;
      expect(await ask('createMark', ID, 'previous', interrupted(fields))).toMatchObject({ busy: endedMark(ownMark) });
      expect(entry()?.busy).toEqual(endedMark(ownMark));
    }
  });

  it('the fallback is logged as a warning that names the environment', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message: string) => void warnings.push(message) };
    const { ask } = setup({ busy: interrupted() }, logger);
    await ask('markBusy', ID, 'create');
    expect(warnings).toEqual([]);
    await ask('createMark', ID, 'previous', interrupted({ pid: 201 }));
    expect(warnings).toEqual([expect.stringContaining(ID)]);
    expect(warnings[0]).toContain('ended instead');
  });

  it('the fallback on a missing entry answers null, as createMark ended does', async () => {
    const { ask } = setup(null);
    expect(await ask('createMark', ID, 'previous', interrupted())).toBeNull();
    expect(await ask('createMark', ID, 'ended')).toBeNull();
  });

  it('A2-L1: a remembered mark is not written back over a non-create mark of this window', async () => {
    const { ask, entry } = setup({ busy: interrupted() });
    await ask('markBusy', ID, 'update');
    const ownMark = entry()!.busy!;
    expect(ownMark).toMatchObject({ ...OWNER, operation: 'update' });
    await expect(ask('createMark', ID, 'previous', interrupted())).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('not a create mark') });
    expect(entry()?.busy).toEqual(ownMark);
  });

  it('A2-L1: every non-create mark of this window is refused, not only an update mark', async () => {
    for (const operation of ['delete', 'stop', 'future'] as BusyMark['operation'][]) {
      const ownMark: BusyMark = { operation, since: new Date(NOW).toISOString(), ...OWNER };
      for (const args of [[ID, 'ended'], [ID, 'previous'], [ID, 'previous', interrupted()]]) {
        const { ask, entry } = setup({ busy: ownMark });
        await expect(ask('createMark', ...args)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('not a create mark') });
        expect(entry()?.busy).toEqual(ownMark);
      }
    }
  });

  it('A2-L1: a non-create mark of this window ID but another pid is not this window\'s: no refusal, the mark stays', async () => {
    const foreign: BusyMark = { operation: 'update', since: new Date(NOW).toISOString(), windowId: OWNER.windowId, pid: 999 };
    for (const args of [[ID, 'ended'], [ID, 'previous'], [ID, 'previous', interrupted()]]) {
      const { ask, entry } = setup({ busy: foreign });
      expect(await ask('createMark', ...args)).toMatchObject({ busy: foreign });
      expect(entry()?.busy).toEqual(foreign);
    }
  });

  it('openFinished: the remote user as docker exec -u takes it; no leading hyphen, white space or NUL', async () => {
    for (const remoteUser of ['-u', 'a b', 'a\tb', 'a\nb', 'a\u0000b', '\u0000a', ' a']) {
      const { ask, entry } = setup();
      const before = structuredClone(entry());
      await expect(ask('openFinished', ID, { ...FINISH, remoteUser })).rejects.toMatchObject({ code: 'invalid' });
      expect(entry()).toEqual(before);
    }
    expect(await setup().ask('openFinished', ID, { ...FINISH, remoteUser: 'a-b' })).toMatchObject({ remoteUser: 'a-b' });
  });
});
