// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E4b: the registry writes of the open as the worker sends them (workerHostSide) and reads their answers
// (parseEntryAnswer, parseStepMarkAnswer). Plan step 11E4c: the entry of a first open, its removal, the configuration and
// the build records (parseCreatedAnswer, buildArguments).
import { describe, expect, it } from 'vitest';
import type { BuildRecord, BusyMark, Environment, RefusedUpdate } from '../types';
import type { HostRequest } from './hostSide';
import { buildArguments, parseCreatedAnswer, parseEntryAnswer, parseStepMarkAnswer, workerHostSide } from './workerHostSide';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ENTRY = { id: ID, repository: 'acme/api' } as unknown as Environment;
const MARK: BusyMark = { operation: 'update', since: '2026-10-04T12:00:00.000Z', pid: 100, windowId: 'w1' };

function worker(answer: unknown) {
  const requests: HostRequest[] = [];
  const host = workerHostSide(
    async (request) => (requests.push(JSON.parse(JSON.stringify(request)) as HostRequest), answer),
    () => undefined,
  );
  return { records: host.records, requests };
}

describe('the registry writes of the open in the worker (plan step 11E4b)', () => {
  it('sends each one as its request, without a scope, the account, the time or the liveness', async () => {
    const { records, requests } = worker(ENTRY);
    const scope = { dockerHost: 'ssh://elsewhere' };
    await records.createMark(ID, 'ended', undefined, scope);
    await records.createMark(ID, 'previous', undefined);
    await records.createMark(ID, 'previous', MARK);
    await records.releaseStepMark(ID, MARK);
    await records.ownerLogin(ID, scope);
    await records.lifecycleMark(ID, { set: 'a'.repeat(12) });
    await records.lifecycleMark(ID, 'clear');
    await records.openFinished(ID, { remoteWorkspaceFolder: '/workspaces/api', remoteUser: 'node' });
    expect(requests.map(({ kind, call, args }) => [kind, call, ...args])).toEqual([
      ['record', 'createMark', ID, 'ended'],
      // No previous mark: no third argument (JSON would make it null).
      ['record', 'createMark', ID, 'previous'],
      ['record', 'createMark', ID, 'previous', MARK],
      ['record', 'stepMark', ID, 'release', MARK],
      ['record', 'ownerLogin', ID],
      ['record', 'lifecycleMark', ID, { set: 'a'.repeat(12) }],
      ['record', 'lifecycleMark', ID, 'clear'],
      ['record', 'openFinished', ID, { remoteWorkspaceFolder: '/workspaces/api', remoteUser: 'node' }],
    ]);
    const take = worker({ environment: ENTRY, mark: MARK });
    expect(await take.records.takeStepMark(ID, 'update')).toEqual({ environment: ENTRY, mark: MARK });
    expect(take.requests).toEqual([{ kind: 'record', call: 'stepMark', args: [ID, 'take', 'update'] }]);
  });

  it('parseEntryAnswer: the entry of the environment, or undefined for none; anything else fails', () => {
    expect(parseEntryAnswer(ENTRY, ID)).toEqual(ENTRY);
    expect(parseEntryAnswer(null, ID)).toBeUndefined();
    for (const value of [undefined, {}, { id: 'other' }, [ENTRY], 'entry', true]) {
      expect(() => parseEntryAnswer(value, ID)).toThrow('invalid value');
    }
  });

  it('parseStepMarkAnswer: the entry with its mark or with the conflict, or undefined; anything else fails', () => {
    expect(parseStepMarkAnswer({ environment: ENTRY, mark: MARK }, ID)).toEqual({ environment: ENTRY, mark: MARK });
    expect(parseStepMarkAnswer({ environment: ENTRY, conflict: MARK }, ID)).toEqual({ environment: ENTRY, conflict: MARK });
    expect(parseStepMarkAnswer(null, ID)).toBeUndefined();
    for (const value of [
      undefined,
      {},
      ENTRY,
      { mark: MARK },
      { environment: ENTRY },
      { environment: { id: 'other' }, mark: MARK },
      { environment: ENTRY, mark: MARK, conflict: MARK },
      { environment: ENTRY, mark: { ...MARK, operation: 'build' } },
      { environment: ENTRY, mark: { ...MARK, pid: 1.5 } },
      { environment: ENTRY, conflict: { ...MARK, windowId: 7 } },
    ]) {
      expect(() => parseStepMarkAnswer(value, ID)).toThrow('invalid value');
    }
  });

  it('a failed or odd answer is a failure of the call, never a mark of this window', async () => {
    await expect(worker({ environment: ENTRY }).records.takeStepMark(ID, 'update')).rejects.toThrow('invalid value');
    await expect(worker({ id: 'other' }).records.openFinished(ID, { remoteWorkspaceFolder: '/w' })).rejects.toThrow('invalid value');
    expect(await worker(null).records.ownerLogin(ID)).toBeUndefined();
  });

  describe('plan step 11E4c', () => {
    const record = { environmentImage: 'devenv-acme-api-x:2', buildNumber: 2 } as BuildRecord;
    const refused = { configPath: '.devcontainer/devcontainer.json', items: 'x' } as RefusedUpdate;

    it('sends each one as its request: the ID, repository and configuration of the entry only, and the kind of the build first', async () => {
      const { records, requests } = worker(ENTRY);
      const scope = { dockerHost: 'ssh://elsewhere' };
      expect(await records.createEnvironment(ID, 'acme/api', '.devcontainer/devcontainer.json', scope)).toEqual(ENTRY);
      await records.dropCreated(ID, scope);
      await records.configuration(ID, { addVolumes: ['v1'], cloned: true });
      await records.build(ID, { kind: 'number', buildNumber: 3 });
      await records.build(ID, { kind: 'record', record, dropRefused: true });
      await records.build(ID, { kind: 'rebaseline', environmentImage: 'devenv-acme-api-x:2', configHash: 'h', version: '2.40.0' });
      await records.build(ID, { kind: 'refused', refusedUpdate: refused });
      expect(requests.map(({ kind, call, args }) => [kind, call, ...args])).toEqual([
        ['record', 'createEnvironment', { id: ID, repository: 'acme/api', configPath: '.devcontainer/devcontainer.json' }],
        ['record', 'dropCreated', ID],
        ['record', 'configuration', ID, { addVolumes: ['v1'], cloned: true }],
        ['record', 'build', ID, 'number', 3],
        ['record', 'build', ID, 'record', record, true],
        ['record', 'build', ID, 'rebaseline', 'devenv-acme-api-x:2', 'h', '2.40.0'],
        ['record', 'build', ID, 'refused', refused],
      ]);
    });

    it('buildArguments: the kind, then the values of the change, each in its place', () => {
      expect(buildArguments({ kind: 'number', buildNumber: 1 })).toEqual(['number', 1]);
      expect(buildArguments({ kind: 'record', record, dropRefused: false })).toEqual(['record', record, false]);
      expect(buildArguments({ kind: 'rebaseline', environmentImage: 'i', configHash: 'h', version: 'v' })).toEqual(['rebaseline', 'i', 'h', 'v']);
      expect(buildArguments({ kind: 'refused', refusedUpdate: refused })).toEqual(['refused', refused]);
    });

    it('parseCreatedAnswer: an entry of the repository (the new one or another of it); anything else fails', () => {
      expect(parseCreatedAnswer(ENTRY, 'acme/api')).toEqual(ENTRY);
      expect(parseCreatedAnswer({ ...ENTRY, id: 'other' }, 'ACME/api')).toEqual({ ...ENTRY, id: 'other' });
      for (const value of [null, undefined, {}, { id: ID }, { id: '', repository: 'acme/api' }, { id: 7, repository: 'acme/api' }, { id: ID, repository: 'acme/web' }, [ENTRY], 'entry']) {
        expect(() => parseCreatedAnswer(value, 'acme/api'), JSON.stringify(value)).toThrow('invalid value');
      }
    });

    it('a failed or odd answer is a failure of the call', async () => {
      await expect(worker(null).records.createEnvironment(ID, 'acme/api', '.devcontainer/devcontainer.json')).rejects.toThrow('invalid value');
      await expect(worker({ id: 'other' }).records.configuration(ID, { cloned: true })).rejects.toThrow('invalid value');
      await expect(worker({ id: 'other' }).records.build(ID, { kind: 'number', buildNumber: 2 })).rejects.toThrow('invalid value');
      expect(await worker(null).records.build(ID, { kind: 'number', buildNumber: 2 })).toBeUndefined();
      expect(await worker('ignored').records.dropCreated(ID)).toBeUndefined();
    });
  });
});
