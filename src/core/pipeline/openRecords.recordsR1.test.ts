// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #104 (B, mutation probes): the own-mark test of OpenRecords (window AND process), sameBusyMark
// over pid and windowId, a mark of this process in another window at openFinished, and the call sites of
// EnvironmentService (cloned on "clone again", dropRefused of an adopted image record, the liveness of openFinished, and
// keepRefusedFor of a fallback configuration).
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../ports';
import { CommandError } from '../errors';
import type { BusyMark, Environment, RefusedUpdate, WindowStatus } from '../types';
import { LABEL_BUILD_RECORD, LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, environmentImageName } from '../names';
import type { RepositoryTarget } from './operationBase';
import {
  ACCOUNT,
  BASE_IMAGE,
  DEFAULT_CONFIG_TEXT,
  DIGEST_NEW,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  PID,
  REPO,
  WINDOW_ID,
  createHarness,
  imageConfigWithUser,
  seedEnvironment,
  type Harness,
} from './environmentService.testkit';
import { otherWindowMarkIsLive, registryOpenRecords, sameBusyMark, type OpenFinish, type OpenRecords } from './openRecords';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import { configHash } from './pipelineRules';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const OWNER = { windowId: 'window-1', pid: 100 };

function setup(fields: Partial<Environment> = {}) {
  const base = { id: ID, repository: 'acme/api', owner: { id: '7', login: 'old' }, configPath: '.devcontainer/devcontainer.json', ...fields } as unknown as Environment;
  const entries = new Map<string, Environment>([[ID, base]]);
  const registry = {
    add: async (environment: Environment) => void entries.set(environment.id, structuredClone(environment)),
    remove: async (id: string) => void entries.delete(id),
    updateEnvironment: async (id: string, mutator: (entry: Environment) => void) => {
      const entry = entries.get(id);
      if (!entry) return undefined;
      const copy = structuredClone(entry);
      mutator(copy);
      entries.set(id, copy);
      return copy;
    },
  };
  return registryOpenRecords(registry, { owner: OWNER, clock: { now: () => NOW }, isAlive: () => true, logger: silentLogger });
}

const mark = (fields: Partial<BusyMark> = {}): BusyMark => ({ operation: 'create', since: new Date(NOW - 60_000).toISOString(), pid: OWNER.pid, windowId: OWNER.windowId, ...fields });
/** The same process (an earlier activation), another window ID; and the same window ID, another process. */
const sameProcess = () => mark({ windowId: 'earlier' });
const sameWindowId = () => mark({ pid: 300 });

describe('the own mark is this window AND this process (O09, O10, O11)', () => {
  it('createMark ended: a mark of this process in another window, or of this window ID in another process, stays as it is', async () => {
    expect((await setup({ busy: sameProcess() }).createMark(ID, 'ended'))?.busy).toEqual(sameProcess());
    expect((await setup({ busy: sameWindowId() }).createMark(ID, 'ended'))?.busy).toEqual(sameWindowId());
  });

  it('createMark previous: only over a mark of this window; a previous mark of another window comes back as it was', async () => {
    expect((await setup({ busy: sameProcess() }).createMark(ID, 'previous', undefined))?.busy).toEqual(sameProcess());
    expect((await setup({ busy: sameWindowId() }).createMark(ID, 'previous', undefined))?.busy).toEqual(sameWindowId());
    expect((await setup({ busy: mark() }).createMark(ID, 'previous', sameProcess()))?.busy).toEqual(sameProcess());
    expect((await setup({ busy: mark() }).createMark(ID, 'previous', sameWindowId()))?.busy).toEqual(sameWindowId());
  });
});

describe('sameBusyMark compares the process and the window too (O04, O05)', () => {
  it('another pid or window ID is another mark, and releaseStepMark keeps it', async () => {
    const m = mark({ operation: 'update' });
    expect(sameBusyMark(m, { ...m, pid: 101 })).toBe(false);
    expect(sameBusyMark(m, { ...m, windowId: 'window-9' })).toBe(false);
    const records = setup({ busy: m });
    expect((await records.releaseStepMark(ID, { ...m, pid: 101 }))?.busy).toEqual(m);
    expect((await records.releaseStepMark(ID, { ...m, windowId: 'window-9' }))?.busy).toEqual(m);
  });
});

describe('a mark of this process in another window is no live mark of another window (O07)', () => {
  it('otherWindowMarkIsLive is false, and openFinished removes it', async () => {
    const view = { owner: OWNER, isAlive: () => true };
    expect(otherWindowMarkIsLive(sameProcess(), view, { now: NOW })).toBe(false);
    const finished = await setup({ busy: sameProcess() }).openFinished(ID, { lastUsedAt: '2026-10-04T12:00:00.000Z', remoteWorkspaceFolder: '/workspaces/api', liveness: { now: NOW } });
    expect(finished).toBeDefined();
    expect(finished).not.toHaveProperty('busy');
  });
});

describe('the call sites of EnvironmentService', () => {
  const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
  let h: Harness | undefined;

  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  /** A harness whose OpenRecords is the registry's, with each call recorded. */
  function spied(statuses?: readonly WindowStatus[]) {
    let inner: OpenRecords | undefined;
    const calls: { method: string; args: unknown[] }[] = [];
    const spy = new Proxy({} as OpenRecords, {
      get: (_target, method) =>
        typeof method !== 'string' || method === 'then'
          ? undefined
          : (...args: unknown[]) => {
              calls.push({ method, args });
              return (inner as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
            },
    });
    const windowStatuses = statuses === undefined ? undefined : async () => statuses;
    const harness = createHarness({ openRecords: spy, ...(windowStatuses ? { windowStatuses } : {}) });
    inner = registryOpenRecords(harness.registry, {
      owner: { windowId: WINDOW_ID, pid: PID },
      clock: harness.clock,
      isAlive: (pid) => pid === PID || harness.alivePids.has(pid),
      ...(windowStatuses ? { windowStatuses } : {}),
      logger: harness.logger,
    });
    h = harness;
    return { h: harness, calls };
  }

  it('E03: a repository cloned again has no Git state, also when the open fails after the clone', async () => {
    const { h, calls } = spied();
    await seedEnvironment(h, { volume: false, container: null });
    h.ui.filesMissingAnswer = 'cloneAgain';
    h.helper.upError = () => new CommandError('devcontainer up', 1, '', 'failed');
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    expect(h.helper.clones).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'configuration').map((call) => call.args[1])).toContainEqual({ cloned: true });
    expect((await h.registry.get(ENV_ID))?.gitSummary).toBeUndefined();
  });

  it('E09: a build record taken from an existing image keeps the refused update (dropRefused false)', async () => {
    const { h, calls } = spied();
    const refused: RefusedUpdate = { configPath: DEFAULT_CONFIG_PATH, configHash: configHash(DEFAULT_CONFIG_TEXT), images: {}, features: {}, items: 'docker.sock' };
    await seedEnvironment(h, { record: null, container: null, extra: { refusedUpdate: refused } });
    const image = environmentImageName(REPO, ENV_ID, 3);
    const record = { builtAt: '2026-09-30T10:00:00.000Z', environmentImage: image, buildNumber: 3, configPath: DEFAULT_CONFIG_PATH, configHash: configHash(DEFAULT_CONFIG_TEXT), images: { [BASE_IMAGE]: DIGEST_NEW }, features: { [FEATURE]: FEATURE_DIGEST } };
    h.docker.images.add(image);
    const config = imageConfigWithUser('vscode');
    h.docker.imageConfigs.set(image, {
      ...config,
      Labels: { ...config.Labels, [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_BUILD_RECORD]: JSON.stringify(record) },
    });
    await h.service.open(TARGET, { progress: h.progress });
    expect(h.helper.builds).toEqual([]);
    const builds = calls.filter((call) => call.method === 'build').map((call) => call.args[1]);
    expect(builds).toEqual([{ kind: 'record', record: { ...record, imageId: `sha256:image-of-${image}` }, dropRefused: false }]);
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toEqual(refused);
  });

  it('E17: openFinished decides with the liveness that the open read (window status files and time)', async () => {
    const statuses: WindowStatus[] = [];
    const { h, calls } = spied(statuses);
    await seedEnvironment(h);
    await h.service.open(TARGET, { progress: h.progress });
    const finished = calls.filter((call) => call.method === 'openFinished');
    expect(finished).toHaveLength(1);
    const finish = finished[0].args[1] as OpenFinish;
    expect(finish.liveness.windowStatuses).toBe(statuses);
    expect(finish.liveness.now).toBeGreaterThanOrEqual(Date.parse('2026-09-24T15:40:00.000Z'));
  });

  it('E06: a fallback configuration keeps the refused update of the configuration that was loaded', async () => {
    const { h } = spied();
    const PYTHON = '.devcontainer/python/devcontainer.json';
    const PYTHON_TEXT = '{ "image": "python:3.12" }';
    const refused: RefusedUpdate = { configPath: DEFAULT_CONFIG_PATH, configHash: configHash(DEFAULT_CONFIG_TEXT), images: {}, features: {}, items: 'docker.sock' };
    await seedEnvironment(h, {
      record: { configPath: PYTHON, configHash: configHash(PYTHON_TEXT), images: { 'python:3.12': DIGEST_NEW }, features: {} },
      extra: { configPath: PYTHON, refusedUpdate: refused },
    });
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
    await h.service.open(TARGET, { progress: h.progress });
    const env = await h.registry.get(ENV_ID);
    expect(env?.configPath).toBe(PYTHON);
    expect(env?.refusedUpdate).toEqual(refused);
  });
});
