// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E4b (decision of 2026-10-04, one operations interface in both directions): the registry writes of the open
// that the worker sends (`record createMark`, `record stepMark`, `record ownerLogin`, `record lifecycleMark`, `record
// openFinished`), as the extension checks them (hostSideHandler) and applies them under its registry lock
// (requestOpenRecords), with its owner, clock, account and view of the windows. No operation sends them before plan step
// 11E6, so the handler runs here with an explicit allowance.
import { describe, expect, it } from 'vitest';
import { OP_DELETE } from '../helperChannel/protocol';
import { registryBusyMarks, type BusyMarkView } from '../pipeline/busyMarks';
import { endedMark } from '../pipeline/openRecords';
import { silentLogger } from '../ports';
import type { BusyMark, Environment, GitHubAccount, WindowStatus } from '../types';
import { FLOW_REQUESTS, type HostCall, type HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';
import { requestOpenRecords, type OpenRequestScope } from './openRequests';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const MISSING = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const HOST = 'ssh://box';
const OWNER = { windowId: 'w1', pid: 100 };
/** The account signed in in the extension. */
const ACCOUNT: GitHubAccount = { id: '42', login: 'octo' };
const CONTAINER = 'a'.repeat(64);
const OPEN_REQUESTS: readonly HostCall[] = ['record markBusy', 'record createMark', 'record stepMark', 'record ownerLogin', 'record lifecycleMark', 'record openFinished'];

const own = (fields: Partial<BusyMark> = {}): BusyMark => ({ operation: 'create', since: new Date(NOW - 60_000).toISOString(), pid: OWNER.pid, windowId: OWNER.windowId, ...fields });
const other = (fields: Partial<BusyMark> = {}): BusyMark => ({ operation: 'update', since: new Date(NOW - 60_000).toISOString(), pid: 200, windowId: 'w2', ...fields });
/** A recent status file of the other window: its mark is live. */
const OTHER_LIVE: WindowStatus[] = [{ windowId: 'w2', pid: 200, updatedAt: new Date(NOW - 5_000).toISOString() } as WindowStatus];
const FINISH = { remoteWorkspaceFolder: '/workspaces/api' };

/**
 * The extension's side over an in-memory registry: the busy marks and the writes of the open as the extension wires them
 * (src/vscode/hostSide.ts), with the handler of one operation of `ID` on HOST.
 */
function setup(fields: Partial<Environment> = {}, options: { windowStatuses?: readonly WindowStatus[]; scope?: { environmentId?: string; dockerHost?: string } } = {}) {
  const entry = { id: ID, repository: 'acme/api', owner: { id: ACCOUNT.id, login: 'old' }, dockerHost: HOST, lastUsedAt: '2020-01-01T00:00:00.000Z', ...fields } as Environment;
  const entries = new Map<string, Environment>([[ID, entry]]);
  const registry = {
    updateEnvironment: async (id: string, mutator: (entry: Environment) => void | Promise<void>) => {
      const found = entries.get(id);
      if (!found) return undefined;
      const copy = structuredClone(found);
      // As the registry: a mutator that throws writes nothing.
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
    markBusy: (id: string, operation: BusyMark['operation'], onReplaced?: (mark: BusyMark) => void) => busyMarks.mark(id, operation, onReplaced),
    createMark: (id: string, kind: 'ended' | 'previous', previous: BusyMark | undefined, scope?: OpenRequestScope) => open(scope).createMark(id, kind, previous),
    takeStepMark: (id: string, operation: BusyMark['operation'], scope?: OpenRequestScope) => open(scope).takeStepMark(id, operation),
    releaseStepMark: (id: string, mark: BusyMark, scope?: OpenRequestScope) => open(scope).releaseStepMark(id, mark),
    ownerLogin: (id: string, scope?: OpenRequestScope) => open(scope).ownerLogin(id),
    lifecycleMark: (id: string, change: 'clear' | { set: string }, scope?: OpenRequestScope) => open(scope).lifecycleMark(id, change),
    openFinished: (id: string, finish: typeof FINISH, scope?: OpenRequestScope) => open(scope).openFinished(id, finish),
  };
  const host = { questions: {}, state: {}, records, secrets: {}, connect: {} } as unknown as HostSide;
  const handlerOf = () => hostSideHandler(host, silentLogger, OPEN_REQUESTS, options.scope ?? { environmentId: ID, dockerHost: HOST });
  const handler = handlerOf();
  const signal = new AbortController().signal;
  const ask = (call: string, ...args: unknown[]) => handler('record', { call, args }, signal).then((answer) => answer.value);
  return { ask, entry: () => entries.get(ID), handlerOf, signal };
}

/** One request of each kind, as the worker sends it for ID. */
const REQUESTS: readonly [string, ...unknown[]][] = [
  ['createMark', ID, 'ended'],
  ['createMark', ID, 'previous'],
  ['stepMark', ID, 'take', 'update'],
  ['stepMark', ID, 'release', own()],
  ['ownerLogin', ID],
  ['lifecycleMark', ID, 'clear'],
  ['openFinished', ID, FINISH],
];

describe('the registry writes of the open as requests (plan step 11E4b)', () => {
  it('no operation may send them before plan step 11E6', async () => {
    for (const allowed of Object.values(FLOW_REQUESTS)) {
      expect(allowed.filter((call) => /^record (createMark|stepMark|ownerLogin|lifecycleMark|openFinished)/.test(call))).toEqual([]);
    }
    const handler = hostSideHandler({ records: {} } as unknown as HostSide, silentLogger, FLOW_REQUESTS[OP_DELETE], { environmentId: ID, dockerHost: HOST });
    await expect(handler('record', { call: 'ownerLogin', args: [ID] }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid' });
  });

  it.each(REQUESTS)('%s: refused for another environment, Docker host or owner, and without a Docker host; nothing is written', async (call, ...args) => {
    const busy = own();
    const fields = { busy, lifecycleIncomplete: CONTAINER };
    // Another environment than the one of the operation.
    const elsewhere = setup(fields, { scope: { environmentId: MISSING, dockerHost: HOST } });
    await expect(elsewhere.ask(call, ...args)).rejects.toMatchObject({ code: 'invalid' });
    // An entry on another Docker host, or the local Docker.
    for (const dockerHost of ['ssh://other', undefined]) {
      const { ask, entry } = setup({ ...fields, dockerHost });
      const before = structuredClone(entry());
      await expect(ask(call, ...args)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another Docker host') });
      expect(entry()).toEqual(before);
    }
    // An entry of another account.
    const foreign = setup({ ...fields, owner: { id: '7', login: 'other' } });
    const before = structuredClone(foreign.entry());
    await expect(foreign.ask(call, ...args)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another account') });
    expect(foreign.entry()).toEqual(before);
    // An operation without a Docker host.
    await expect(setup(fields, { scope: { environmentId: ID } }).ask(call, ...args)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a missing entry is null, as in OpenRecords', async () => {
    const { ask } = setup({}, { scope: { environmentId: MISSING, dockerHost: HOST } });
    expect(await ask('ownerLogin', MISSING)).toBeNull();
    expect(await ask('lifecycleMark', MISSING, 'clear')).toBeNull();
    expect(await ask('stepMark', MISSING, 'take', 'update')).toBeNull();
  });

  describe('the bounds of each kind', () => {
    it('lifecycleMark: a container ID of 12 to 64 hex digits, or clear; nothing else', async () => {
      const { ask, entry } = setup();
      for (const id of ['a'.repeat(12), CONTAINER]) {
        expect(await ask('lifecycleMark', ID, { set: id })).toMatchObject({ lifecycleIncomplete: id });
      }
      for (const change of [{ set: 'a'.repeat(11) }, { set: 'a'.repeat(65) }, { set: 'g'.repeat(12) }, { set: 'devenv-api' }, { set: CONTAINER, by: 'x' }, {}, 'set', null]) {
        await expect(ask('lifecycleMark', ID, change)).rejects.toMatchObject({ code: 'invalid' });
      }
      await expect(ask('lifecycleMark', ID, 'clear', 'more')).rejects.toMatchObject({ code: 'invalid' });
      expect(entry()?.lifecycleIncomplete).toBe(CONTAINER);
      expect(await ask('lifecycleMark', ID, 'clear')).not.toHaveProperty('lifecycleIncomplete');
    });

    it('openFinished: its closed list of fields, a POSIX user, an absolute folder, container IDs, a checked Git state', async () => {
      // Review round 1 of PR #105 (A-L2): the user as `docker exec -u` takes it (before: a POSIX name of at most 64).
      for (const remoteUser of ['john@corp', 'svc$', 'u'.repeat(65), 'u'.repeat(256)]) {
        await expect(setup().ask('openFinished', ID, { ...FINISH, remoteUser })).resolves.toMatchObject({ remoteUser });
      }
      const refused = [
        { ...FINISH, remoteUser: 'u'.repeat(257) },
        { ...FINISH, remoteUser: '-root' },
        { ...FINISH, remoteUser: 'ro ot' },
        { ...FINISH, remoteUser: '' },
        { remoteWorkspaceFolder: 'workspaces/api' },
        { remoteWorkspaceFolder: '/workspaces/../etc' },
        { remoteWorkspaceFolder: '/workspaces/api\n' },
        { remoteWorkspaceFolder: `/${'a'.repeat(4096)}` },
        {},
        { ...FINISH, lifecycleMarkRead: 'abc' },
        { ...FINISH, lifecycleRanFor: 'x'.repeat(12) },
        { ...FINISH, gitSummary: { branch: 'b'.repeat(256), uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-04T12:00:00.000Z' } },
        { ...FINISH, gitSummary: { branch: 'main', uncommittedFiles: -1, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-04T12:00:00.000Z' } },
        { ...FINISH, gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: 'yesterday' } },
        // Fields outside the closed list: the time and the liveness are the extension's, the rest is not the open's.
        { ...FINISH, lastUsedAt: '2030-01-01T00:00:00.000Z' },
        { ...FINISH, liveness: { now: 0 } },
        { ...FINISH, keepRunningOnce: true },
        { ...FINISH, ['__proto__']: { busy: null } },
      ];
      for (const finish of refused) {
        const { ask, entry } = setup();
        const before = structuredClone(entry());
        await expect(ask('openFinished', ID, finish)).rejects.toMatchObject({ code: 'invalid' });
        expect(entry()).toEqual(before);
      }
      const { ask } = setup();
      await expect(ask('openFinished', ID, FINISH, 'more')).rejects.toMatchObject({ code: 'invalid' });
      const gitSummary = { branch: 'main', uncommittedFiles: 1, unpushedCommits: 2, stashes: 0, recordedAt: '2026-10-04T11:59:00.000Z' };
      const accepted = { remoteWorkspaceFolder: `/${'a'.repeat(4095)}`, remoteUser: 'u'.repeat(64), lifecycleMarkRead: CONTAINER, lifecycleRanFor: 'b'.repeat(12), gitSummary: { ...gitSummary, extra: 1 } };
      // The Git state is rebuilt from its five fields (as `record recordGitSummary`).
      expect(await setup().ask('openFinished', ID, accepted)).toMatchObject({ remoteWorkspaceFolder: accepted.remoteWorkspaceFolder, remoteUser: accepted.remoteUser, gitSummary });
      expect((await setup().ask('openFinished', ID, accepted)) as Environment).not.toHaveProperty('gitSummary.extra');
    });

    it('stepMark: a known operation to take, a well-formed mark to release, and nothing more', async () => {
      const { ask } = setup();
      for (const args of [
        ['take', 'build'],
        ['take', 'update', 'more'],
        ['grab', 'update'],
        ['release', { ...own(), extra: 1 }],
        ['release', own({ pid: 0 })],
        ['release', own({ since: 'now' })],
        ['release', own({ windowId: 'w'.repeat(257) })],
        ['release', own({ windowId: '' })],
        ['release', own({ operation: 'build' as never })],
        ['release'],
      ]) {
        await expect(ask('stepMark', ID, ...args)).rejects.toMatchObject({ code: 'invalid' });
      }
    });

    it('ownerLogin and createMark: no argument beyond their list; the worker sends no account', async () => {
      const { ask, entry } = setup({ busy: own() });
      await expect(ask('ownerLogin', ID, { id: ACCOUNT.id, login: 'mallory' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(ask('createMark', ID, 'ended', own())).rejects.toMatchObject({ code: 'invalid' });
      await expect(ask('createMark', ID, 'previous', undefined, 'more')).rejects.toMatchObject({ code: 'invalid' });
      await expect(ask('createMark', ID, 'cleared')).rejects.toMatchObject({ code: 'invalid' });
      expect(entry()).toMatchObject({ owner: { login: 'old' }, busy: own() });
    });
  });

  describe('a foreign mark', () => {
    it('stepMark release: only a mark of this window that is the mark of the entry', async () => {
      const mark = other();
      const { ask, entry } = setup({ busy: mark });
      await expect(ask('stepMark', ID, 'release', mark)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('not one of this window') });
      expect(entry()?.busy).toEqual(mark);
      // A mark of this window that is not the one of the entry leaves it.
      const mine = setup({ busy: own({ operation: 'update' }) });
      expect(await mine.ask('stepMark', ID, 'release', own({ operation: 'update', since: new Date(NOW).toISOString() }))).toMatchObject({ busy: own({ operation: 'update' }) });
      expect(await mine.ask('stepMark', ID, 'release', own({ operation: 'update' }))).not.toHaveProperty('busy');
    });

    it('stepMark take: a live mark of another window, or any mark of this window, keeps the entry', async () => {
      const live = setup({ busy: other() }, { windowStatuses: OTHER_LIVE });
      expect(await live.ask('stepMark', ID, 'take', 'update')).toMatchObject({ conflict: other() });
      expect(live.entry()?.busy).toEqual(other());
      const mine = setup({ busy: own() });
      expect(await mine.ask('stepMark', ID, 'take', 'update')).toMatchObject({ conflict: own() });
    });

    it('createMark ended: only a create mark of this window; a mark of another window stays', async () => {
      const theirs = setup({ busy: other({ operation: 'create' }) });
      expect(await theirs.ask('createMark', ID, 'ended')).toMatchObject({ busy: other({ operation: 'create' }) });
      const update = setup({ busy: own({ operation: 'update' }) });
      await expect(update.ask('createMark', ID, 'ended')).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('not a create mark') });
      expect(update.entry()?.busy).toEqual(own({ operation: 'update' }));
      expect(await setup({ busy: own() }).ask('createMark', ID, 'ended')).toMatchObject({ busy: endedMark(own()) });
    });
  });

  describe('createMark previous: only a mark that a markBusy of the same operation replaced', () => {
    const interrupted = endedMark(other({ operation: 'create' }));

    it('gives back the mark that the markBusy of the operation replaced', async () => {
      const { ask, entry } = setup({ busy: interrupted });
      expect(await ask('markBusy', ID, 'create')).toMatchObject({ environment: { busy: { pid: OWNER.pid, operation: 'create' } } });
      expect(await ask('createMark', ID, 'previous', interrupted)).toMatchObject({ busy: interrupted });
      expect(entry()?.busy).toEqual(interrupted);
    });

    // Review round 1 of PR #105 (A-L1): changed (before: refused, which left the create mark of this window live for
    // the rest of the window): a mark that is not one the markBusy of this operation replaced ends that create mark.
    it('any other mark, a malformed one, or one that another operation replaced ends the create mark of this window; no mark clears the own', async () => {
      const { ask, entry, handlerOf, signal } = setup({ busy: interrupted });
      await ask('markBusy', ID, 'create');
      const ownMark = entry()!.busy!;
      for (const previous of [other(), endedMark(other()), { ...interrupted, pid: 201 }, { ...interrupted, since: 'then' }, 'x', null, { ...interrupted, pid: 'x' }]) {
        expect(await ask('createMark', ID, 'previous', previous)).toMatchObject({ busy: endedMark(ownMark) });
        expect(entry()?.busy).toEqual(endedMark(ownMark));
      }
      // The handler of another operation has not seen that markBusy: the create mark of this window is ended too.
      expect(await handlerOf()('record', { call: 'createMark', args: [ID, 'previous', interrupted] }, signal)).toMatchObject({ value: { busy: endedMark(ownMark) } });
      expect(await ask('createMark', ID, 'previous')).not.toHaveProperty('busy');
    });

    it('review round 1 of PR #105 (A-L1): the mark is found by its four fields as the registry held it, other keys aside; its remembered copy is written', async () => {
      const { ask, entry } = setup({ busy: interrupted });
      await ask('markBusy', ID, 'create');
      expect(await ask('createMark', ID, 'previous', { ...interrupted, extra: 1 })).toMatchObject({ busy: interrupted });
      expect(entry()?.busy).toEqual(interrupted);
    });

    it('a markBusy that replaced nothing gives nothing to give back: the create mark of this window is ended', async () => {
      const { ask, entry } = setup();
      await ask('markBusy', ID, 'create');
      const ownMark = entry()!.busy!;
      // Review round 1 of PR #105 (A-L1): changed (before: refused).
      expect(await ask('createMark', ID, 'previous', interrupted)).toMatchObject({ busy: endedMark(ownMark) });
      expect(entry()?.busy).toEqual(endedMark(ownMark));
    });

    it('review round 1 of PR #105 (A-L3): stepMark takes only an update mark', async () => {
      for (const operation of ['create', 'delete', 'stop', 'other']) {
        const { ask, entry } = setup();
        await expect(ask('stepMark', ID, 'take', operation)).rejects.toMatchObject({ code: 'invalid' });
        expect(entry()?.busy).toBeUndefined();
      }
    });
  });

  describe("the extension's own clock, account and liveness", () => {
    it('stepMark take: the mark of this window with its clock', async () => {
      expect(await setup().ask('stepMark', ID, 'take', 'update')).toMatchObject({ mark: { operation: 'update', since: new Date(NOW).toISOString(), pid: OWNER.pid, windowId: OWNER.windowId } });
    });

    it('ownerLogin: the login of the account signed in in the extension', async () => {
      const { ask, entry } = setup();
      expect(await ask('ownerLogin', ID)).toMatchObject({ owner: ACCOUNT });
      expect(entry()?.owner).toEqual(ACCOUNT);
    });

    it('openFinished: the time of this window, and its view of the windows decides whether another mark is live', async () => {
      const live = setup({ busy: other(), lifecycleIncomplete: CONTAINER }, { windowStatuses: OTHER_LIVE });
      const finished = (await live.ask('openFinished', ID, { ...FINISH, lifecycleMarkRead: CONTAINER })) as Environment;
      expect(finished).toMatchObject({ lastUsedAt: new Date(NOW).toISOString(), remoteWorkspaceFolder: FINISH.remoteWorkspaceFolder, busy: other() });
      expect(finished).not.toHaveProperty('lifecycleIncomplete');
      // Without a recent status file of the other window, its mark protects nothing and goes.
      expect(await setup({ busy: other() }).ask('openFinished', ID, FINISH)).not.toHaveProperty('busy');
      expect(await setup({ busy: own() }).ask('openFinished', ID, FINISH)).not.toHaveProperty('busy');
    });

    it('openFinished: an operation ends once', async () => {
      const { ask } = setup();
      await ask('openFinished', ID, FINISH);
      await expect(ask('openFinished', ID, FINISH)).rejects.toMatchObject({ code: 'invalid' });
    });
  });

  describe('review round 2 of PR #105 (A2-L1 and the missing tests)', () => {
    it('createMark previous, with or without a mark, refuses over a non-create mark of this window and writes nothing', async () => {
      for (const args of [[ID, 'previous'], [ID, 'previous', other({ operation: 'create' })]]) {
        const { ask, entry } = setup({ busy: own({ operation: 'update' }) });
        await expect(ask('createMark', ...args)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('not a create mark') });
        expect(entry()?.busy).toEqual(own({ operation: 'update' }));
      }
    });

    it('the fallback of an unknown previous mark leaves a create mark of another window as it is', async () => {
      const theirs = other({ operation: 'create' });
      const { ask, entry } = setup({ busy: theirs });
      expect(await ask('createMark', ID, 'previous', other())).toMatchObject({ busy: theirs });
      expect(entry()?.busy).toEqual(theirs);
    });

    it('openFinished takes a remote user with shell and URI characters, as `docker exec -u` takes it', async () => {
      for (const remoteUser of ['a$b', 'a`b', 'a;b', 'node:node', 'a@b', 'a/b']) {
        await expect(setup().ask('openFinished', ID, { ...FINISH, remoteUser })).resolves.toMatchObject({ remoteUser });
      }
    });
  });
});
