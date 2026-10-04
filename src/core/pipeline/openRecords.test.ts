// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E4a (decision of 2026-10-04): the registry writes of the open as specific operations over the registry of
// this computer (registryOpenRecords), decided with the clock and view of the window that runs them.
import { describe, expect, it } from 'vitest';
import { BUSY_MARK_MAX_AGE_MS } from '../busy';
import { silentLogger } from '../ports';
import type { BuildRecord, BusyMark, Environment, GitSummary, RefusedUpdate, WindowStatus } from '../types';
import type { BusyMarkView } from './busyMarks';
import { endedMark, readLiveness, registryOpenRecords, sameBusyMark, type MarkLiveness } from './openRecords';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const MISSING = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const OWNER = { windowId: 'window-1', pid: 100 };
const FULL_ID = 'a'.repeat(64);
const OTHER_FULL_ID = 'b'.repeat(64);

function setup(fields: Partial<Environment> = {}, view: Partial<BusyMarkView> = {}) {
  const base = { id: ID, repository: 'acme/api', owner: { id: '7', login: 'old' }, configPath: '.devcontainer/devcontainer.json', ...fields } as unknown as Environment;
  const entries = new Map<string, Environment>([[ID, base]]);
  const removed: { id: string; volumes: unknown }[] = [];
  const registry = {
    add: async (environment: Environment) => {
      if (entries.has(environment.id)) throw new Error('exists');
      entries.set(environment.id, structuredClone(environment));
    },
    remove: async (id: string, volumes: { kept?: readonly string[] } = {}) => {
      removed.push({ id, volumes });
      entries.delete(id);
    },
    updateEnvironment: async (id: string, mutator: (entry: Environment) => void) => {
      const entry = entries.get(id);
      if (!entry) return undefined;
      const copy = structuredClone(entry);
      mutator(copy);
      entries.set(id, copy);
      return copy;
    },
  };
  const records = registryOpenRecords(registry, { owner: OWNER, clock: { now: () => NOW }, isAlive: () => true, logger: silentLogger, ...view });
  return { records, entry: (id = ID) => entries.get(id), removed };
}

const other = (fields: Partial<BusyMark> = {}): BusyMark => ({ operation: 'update', since: new Date(NOW - 60_000).toISOString(), pid: 200, windowId: 'window-2', ...fields });
const own = (fields: Partial<BusyMark> = {}): BusyMark => ({ operation: 'create', since: new Date(NOW - 60_000).toISOString(), pid: OWNER.pid, windowId: OWNER.windowId, ...fields });
const live: MarkLiveness = { now: NOW };

function buildRecord(fields: Partial<BuildRecord> = {}): BuildRecord {
  return { builtAt: '2026-10-01T00:00:00.000Z', environmentImage: 'devenv-acme-api-x:3', buildNumber: 3, configPath: '.devcontainer/devcontainer.json', configHash: 'sha256:old', images: {}, features: {}, ...fields };
}

const composeRecord = () => buildRecord({ compose: { service: 'app', images: ['p-app'], serviceImages: [], version: '2.29.0', inputsHash: 'sha256:inputs' } });

function refused(fields: Partial<RefusedUpdate> = {}): RefusedUpdate {
  return { configPath: '.devcontainer/devcontainer.json', configHash: 'sha256:c', images: {}, features: {}, items: 'docker.sock', ...fields };
}

describe('the registry writes of the open (plan step 11E4a)', () => {
  describe('createEnvironment, dropCreated', () => {
    it('adds the entry of a first open, and fails when the registry has it already', async () => {
      const { records, entry } = setup();
      const environment = { id: MISSING, repository: 'acme/web' } as unknown as Environment;
      await records.createEnvironment(environment);
      expect(entry(MISSING)).toEqual(environment);
      await expect(records.createEnvironment(environment)).rejects.toThrow('exists');
    });

    it('removes the entry of a refused first open, keeping no volume', async () => {
      const { records, entry, removed } = setup();
      await records.dropCreated(ID);
      expect(entry()).toBeUndefined();
      expect(removed).toEqual([{ id: ID, volumes: { kept: [] } }]);
    });
  });

  describe('createMark', () => {
    it('ended: the mark of this window stays as ended; a mark of another window and no mark stay as they are', async () => {
      const mine = setup({ busy: own() });
      expect((await mine.records.createMark(ID, 'ended'))?.busy).toEqual(endedMark(own()));
      expect(mine.entry()?.busy?.since).toBe(new Date(0).toISOString());
      const theirs = setup({ busy: other() });
      expect((await theirs.records.createMark(ID, 'ended'))?.busy).toEqual(other());
      const none = setup();
      expect((await none.records.createMark(ID, 'ended'))?.busy).toBeUndefined();
    });

    it('previous: the mark of an ended window comes back as it was, one of this window as ended', async () => {
      const ended = other({ operation: 'create', pid: 300 });
      expect((await setup({ busy: own() }).records.createMark(ID, 'previous', ended))?.busy).toEqual(ended);
      const kept = own({ since: '2026-10-04T11:00:00.000Z' });
      expect((await setup({ busy: own() }).records.createMark(ID, 'previous', kept))?.busy).toEqual(endedMark(kept));
    });

    it('previous: without one, the mark of this window goes', async () => {
      const result = await setup({ busy: own() }).records.createMark(ID, 'previous', undefined);
      expect(result).toBeDefined();
      expect(result?.busy).toBeUndefined();
    });

    it('previous: only when the entry holds a mark of this window', async () => {
      expect((await setup({ busy: other() }).records.createMark(ID, 'previous', undefined))?.busy).toEqual(other());
      expect((await setup().records.createMark(ID, 'previous', other({ pid: 300 })))?.busy).toBeUndefined();
    });

    it('a missing entry is undefined', async () => {
      expect(await setup().records.createMark(MISSING, 'ended')).toBeUndefined();
    });
  });

  describe('takeStepMark, releaseStepMark', () => {
    const mark: BusyMark = { operation: 'update', since: new Date(NOW).toISOString(), pid: OWNER.pid, windowId: OWNER.windowId };

    it('sets the mark of this window with its clock, and returns it with the entry', async () => {
      const { records, entry } = setup();
      expect(await records.takeStepMark(ID, 'update')).toEqual({ environment: expect.objectContaining({ id: ID, busy: mark }), mark });
      expect(entry()?.busy).toEqual(mark);
    });

    it('never over a live mark of another window, nor over any mark of this window or process', async () => {
      for (const busy of [other(), own(), own({ windowId: 'earlier' })]) {
        const { records, entry } = setup({ busy });
        expect(await records.takeStepMark(ID, 'update')).toEqual({ environment: expect.objectContaining({ busy }), conflict: busy });
        expect(entry()?.busy).toEqual(busy);
      }
    });

    it('over a mark that is not live: an ended process, older than 6 hours, a window without a recent status file', async () => {
      expect(await setup({ busy: other() }, { isAlive: (pid) => pid !== 200 }).records.takeStepMark(ID, 'update')).toMatchObject({ mark });
      expect(await setup({ busy: other({ since: new Date(NOW - BUSY_MARK_MAX_AGE_MS - 1).toISOString() }) }).records.takeStepMark(ID, 'update')).toMatchObject({ mark });
      const statuses: WindowStatus[] = [];
      expect(await setup({ busy: other() }, { windowStatuses: async () => statuses }).records.takeStepMark(ID, 'update')).toMatchObject({ mark });
    });

    it('window status files that cannot be read: the rule without them (logged)', async () => {
      const lines: string[] = [];
      const { records } = setup({ busy: other() }, { windowStatuses: async () => Promise.reject(new Error('EACCES')), logger: { ...silentLogger, warn: (text: string) => lines.push(text) } });
      expect(await records.takeStepMark(ID, 'update')).toMatchObject({ conflict: other() });
      expect(lines).toEqual(['The window status files could not be read: EACCES']);
    });

    it('releases only the same mark (sameBusyMark), and returns the entry', async () => {
      const { records, entry } = setup({ busy: mark });
      expect(await records.releaseStepMark(ID, { ...mark, since: '2026-10-04T11:00:00.000Z' })).toMatchObject({ busy: mark });
      expect(await records.releaseStepMark(ID, { ...mark, operation: 'rebuild' })).toMatchObject({ busy: mark });
      const released = await records.releaseStepMark(ID, mark);
      expect(released).toBeDefined();
      expect(released?.busy).toBeUndefined();
      expect(entry()?.busy).toBeUndefined();
      expect(sameBusyMark(mark, { ...mark })).toBe(true);
    });

    it('a missing entry is undefined', async () => {
      const { records } = setup();
      expect(await records.takeStepMark(MISSING, 'update')).toBeUndefined();
      expect(await records.releaseStepMark(MISSING, mark)).toBeUndefined();
    });
  });

  describe('ownerLogin', () => {
    it('takes the login of the account that owns the entry', async () => {
      expect((await setup().records.ownerLogin(ID, { id: '7', login: 'renamed' }))?.owner).toEqual({ id: '7', login: 'renamed' });
    });

    it('never the owner of another account', async () => {
      expect((await setup().records.ownerLogin(ID, { id: '8', login: 'intruder' }))?.owner).toEqual({ id: '7', login: 'old' });
    });

    it('a missing entry is undefined', async () => {
      expect(await setup().records.ownerLogin(MISSING, { id: '7', login: 'x' })).toBeUndefined();
    });
  });

  describe('configuration', () => {
    it('select and shutdownActionNone are written', async () => {
      const result = await setup().records.configuration(ID, { select: '.devcontainer/b/devcontainer.json', shutdownActionNone: true });
      expect(result).toMatchObject({ configPath: '.devcontainer/b/devcontainer.json', shutdownActionNone: true });
      expect((await setup({ shutdownActionNone: true }).records.configuration(ID, { shutdownActionNone: false }))?.shutdownActionNone).toBe(false);
    });

    it('volumes are only added (append-only), in their order, each once', async () => {
      const result = await setup({ additionalVolumes: ['a', 'b'], serviceVolumes: ['s'] }).records.configuration(ID, { addVolumes: ['b', 'c'], addServiceVolumes: ['s', 't'] });
      expect(result?.additionalVolumes).toEqual(['a', 'b', 'c']);
      expect(result?.serviceVolumes).toEqual(['s', 't']);
      const fresh = await setup().records.configuration(ID, { addVolumes: ['x'], addServiceVolumes: ['y'] });
      expect(fresh).toMatchObject({ additionalVolumes: ['x'], serviceVolumes: ['y'] });
    });

    it('no new volume: the fields stay absent', async () => {
      const result = await setup().records.configuration(ID, { addVolumes: [], addServiceVolumes: [] });
      expect(result).not.toHaveProperty('additionalVolumes');
      expect(result).not.toHaveProperty('serviceVolumes');
    });

    it('keepRefusedFor: the refused update of this configuration stays, another (or an invalid one) goes', async () => {
      const same = await setup({ refusedUpdate: refused() }).records.configuration(ID, { keepRefusedFor: { configPath: '.devcontainer/devcontainer.json', configHash: 'sha256:c' } });
      expect(same?.refusedUpdate).toEqual(refused());
      const otherHash = await setup({ refusedUpdate: refused() }).records.configuration(ID, { keepRefusedFor: { configPath: '.devcontainer/devcontainer.json', configHash: 'sha256:d' } });
      expect(otherHash).not.toHaveProperty('refusedUpdate');
      const otherPath = await setup({ refusedUpdate: refused() }).records.configuration(ID, { keepRefusedFor: { configPath: 'b.json', configHash: 'sha256:c' } });
      expect(otherPath).not.toHaveProperty('refusedUpdate');
      const invalid = await setup({ refusedUpdate: { items: 3 } as unknown as RefusedUpdate }).records.configuration(ID, { keepRefusedFor: { configPath: 'b.json', configHash: 'sha256:c' } });
      expect(invalid).not.toHaveProperty('refusedUpdate');
      // Without the field, the entry gets none.
      expect(await setup().records.configuration(ID, { keepRefusedFor: { configPath: 'b.json', configHash: 'sha256:c' } })).not.toHaveProperty('refusedUpdate');
    });

    it('without keepRefusedFor, the refused update stays', async () => {
      expect((await setup({ refusedUpdate: refused() }).records.configuration(ID, { select: 'b.json' }))?.refusedUpdate).toEqual(refused());
    });

    it('serviceFolders replace the recorded ones; an empty list and no overflow remove the fields', async () => {
      const set = await setup({ serviceFolders: ['/old'] }).records.configuration(ID, { serviceFolders: { folders: ['/a', '/b'], overflow: true } });
      expect(set).toMatchObject({ serviceFolders: ['/a', '/b'], serviceFoldersOverflow: true });
      const cleared = await setup({ serviceFolders: ['/old'], serviceFoldersOverflow: true }).records.configuration(ID, { serviceFolders: { folders: [], overflow: false } });
      expect(cleared).not.toHaveProperty('serviceFolders');
      expect(cleared).not.toHaveProperty('serviceFoldersOverflow');
    });

    it('cloned: the Git state goes; other fields stay', async () => {
      const summary: GitSummary = { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-04T00:00:00.000Z' };
      const result = await setup({ gitSummary: summary, additionalVolumes: ['a'] }).records.configuration(ID, { cloned: true });
      expect(result).not.toHaveProperty('gitSummary');
      expect(result?.additionalVolumes).toEqual(['a']);
      expect((await setup({ gitSummary: summary }).records.configuration(ID, {}))?.gitSummary).toEqual(summary);
    });

    it('a missing entry is undefined', async () => {
      expect(await setup().records.configuration(MISSING, { select: 'b.json' })).toBeUndefined();
    });
  });

  describe('build', () => {
    it('number: lastBuildNumber never goes back', async () => {
      expect((await setup({ lastBuildNumber: 4 }).records.build(ID, { kind: 'number', buildNumber: 5 }))?.lastBuildNumber).toBe(5);
      expect((await setup({ lastBuildNumber: 7 }).records.build(ID, { kind: 'number', buildNumber: 5 }))?.lastBuildNumber).toBe(7);
      expect((await setup().records.build(ID, { kind: 'number', buildNumber: 1 }))?.lastBuildNumber).toBe(1);
    });

    it('record: the build record and its number; the refused update goes only with dropRefused', async () => {
      const record = buildRecord({ buildNumber: 6 });
      const built = await setup({ lastBuildNumber: 5, refusedUpdate: refused() }).records.build(ID, { kind: 'record', record, dropRefused: true });
      expect(built).toMatchObject({ buildRecord: record, lastBuildNumber: 6 });
      expect(built).not.toHaveProperty('refusedUpdate');
      const adopted = await setup({ lastBuildNumber: 9, refusedUpdate: refused() }).records.build(ID, { kind: 'record', record, dropRefused: false });
      expect(adopted).toMatchObject({ buildRecord: record, lastBuildNumber: 9, refusedUpdate: refused() });
    });

    it('rebaseline: the Compose record takes the new hash and version, only while its image is unchanged', async () => {
      const result = await setup({ buildRecord: composeRecord() }).records.build(ID, { kind: 'rebaseline', environmentImage: 'devenv-acme-api-x:3', configHash: 'sha256:new', version: '2.30.0' });
      expect(result?.buildRecord).toEqual({ ...composeRecord(), configHash: 'sha256:new', compose: { ...composeRecord().compose, version: '2.30.0' } });
      const rebuilt = await setup({ buildRecord: composeRecord() }).records.build(ID, { kind: 'rebaseline', environmentImage: 'devenv-acme-api-x:2', configHash: 'sha256:new', version: '2.30.0' });
      expect(rebuilt?.buildRecord).toEqual(composeRecord());
    });

    it('rebaseline: nothing without a (valid) Compose record', async () => {
      const change = { kind: 'rebaseline', environmentImage: 'devenv-acme-api-x:3', configHash: 'sha256:new', version: '2.30.0' } as const;
      expect((await setup({ buildRecord: buildRecord() }).records.build(ID, change))?.buildRecord).toEqual(buildRecord());
      expect(await setup().records.build(ID, change)).not.toHaveProperty('buildRecord');
    });

    it('refused: the refused update is recorded', async () => {
      expect((await setup().records.build(ID, { kind: 'refused', refusedUpdate: refused({ reason: 'size' }) }))?.refusedUpdate).toEqual(refused({ reason: 'size' }));
    });

    it('a missing entry is undefined', async () => {
      expect(await setup().records.build(MISSING, { kind: 'number', buildNumber: 1 })).toBeUndefined();
    });
  });

  describe('lifecycleMark', () => {
    it('sets and clears Environment.lifecycleIncomplete', async () => {
      const { records } = setup();
      expect((await records.lifecycleMark(ID, { set: FULL_ID }))?.lifecycleIncomplete).toBe(FULL_ID);
      expect(await records.lifecycleMark(ID, 'clear')).not.toHaveProperty('lifecycleIncomplete');
    });

    it('a missing entry is undefined', async () => {
      expect(await setup().records.lifecycleMark(MISSING, 'clear')).toBeUndefined();
    });
  });

  describe('openFinished', () => {
    const finish = { lastUsedAt: '2026-10-04T12:00:00.000Z', remoteWorkspaceFolder: '/workspaces/api', liveness: live };

    it('records the last use and the container facts; Close and Keep Running ends', async () => {
      const summary: GitSummary = { branch: 'main', uncommittedFiles: 1, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-04T12:00:00.000Z' };
      const result = await setup({ keepRunningOnce: true }).records.openFinished(ID, { ...finish, remoteUser: 'node', gitSummary: summary });
      expect(result).toMatchObject({ lastUsedAt: finish.lastUsedAt, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/api', gitSummary: summary });
      expect(result).not.toHaveProperty('keepRunningOnce');
    });

    it('without a remote user or Git state, the recorded ones stay', async () => {
      const summary: GitSummary = { branch: null, uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-01T00:00:00.000Z' };
      const result = await setup({ remoteUser: 'vscode', gitSummary: summary }).records.openFinished(ID, finish);
      expect(result).toMatchObject({ remoteUser: 'vscode', gitSummary: summary });
    });

    it('the lifecycle mark goes only when it is the one read, or names the container whose commands ran', async () => {
      expect(await setup({ lifecycleIncomplete: FULL_ID }).records.openFinished(ID, { ...finish, lifecycleMarkRead: FULL_ID })).not.toHaveProperty('lifecycleIncomplete');
      expect(await setup({ lifecycleIncomplete: FULL_ID }).records.openFinished(ID, { ...finish, lifecycleRanFor: FULL_ID.slice(0, 12) })).not.toHaveProperty('lifecycleIncomplete');
      expect((await setup({ lifecycleIncomplete: FULL_ID }).records.openFinished(ID, { ...finish, lifecycleMarkRead: OTHER_FULL_ID, lifecycleRanFor: OTHER_FULL_ID }))?.lifecycleIncomplete).toBe(FULL_ID);
      expect((await setup({ lifecycleIncomplete: FULL_ID }).records.openFinished(ID, finish))?.lifecycleIncomplete).toBe(FULL_ID);
    });

    it('the mark of this window goes, and a mark that is not live; a live mark of another window stays', async () => {
      expect(await setup({ busy: own() }).records.openFinished(ID, finish)).not.toHaveProperty('busy');
      expect(await setup({ busy: other() }, { isAlive: (pid) => pid !== 200 }).records.openFinished(ID, finish)).not.toHaveProperty('busy');
      expect(await setup({ busy: other() }).records.openFinished(ID, { ...finish, liveness: { now: NOW, windowStatuses: [] } })).not.toHaveProperty('busy');
      expect((await setup({ busy: other() }).records.openFinished(ID, finish))?.busy).toEqual(other());
    });

    it('decides with the liveness that the caller read, not a new read', async () => {
      let reads = 0;
      const { records } = setup({ busy: other() }, { windowStatuses: async () => (reads++, []) });
      expect((await records.openFinished(ID, finish))?.busy).toEqual(other());
      expect(reads).toBe(0);
    });

    it('a missing entry is undefined', async () => {
      expect(await setup().records.openFinished(MISSING, finish)).toBeUndefined();
    });
  });

  describe('readLiveness', () => {
    it('reads the window status files and the time; a failure is logged, without the files', async () => {
      const statuses: WindowStatus[] = [];
      expect(await readLiveness({ clock: { now: () => NOW }, windowStatuses: async () => statuses, logger: silentLogger })).toEqual({ now: NOW, windowStatuses: statuses });
      const lines: string[] = [];
      const logger = { ...silentLogger, warn: (text: string) => lines.push(text) };
      expect(await readLiveness({ clock: { now: () => NOW }, windowStatuses: async () => Promise.reject(new Error('EACCES')), logger })).toEqual({ now: NOW, windowStatuses: undefined });
      expect(lines).toEqual(['The window status files could not be read: EACCES']);
    });
  });
});
