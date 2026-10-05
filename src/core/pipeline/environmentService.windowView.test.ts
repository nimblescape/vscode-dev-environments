// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E4d: the facts of the window that the pipeline decides with come through its deps, so that the worker's
// pipeline asks the extension for them: whether a process of the computer runs (processAlive, asked before each decision
// about the other windows; a failed answer counts as running), and the window's memory of the containers whose lifecycle
// mark could not be recorded (lifecycleMemory, read under the lock at the start of an open).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { Messages } from '../messages';
import { environmentImageName } from '../names';
import type { Environment, WindowStatus } from '../types';
import type { EnvironmentServiceDeps, RepositoryTarget } from './environmentService';
import { ENV_ID, PID, REPO, T0, WINDOW_ID, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';
import { windowLifecycleMemory, type LifecycleMemory } from './lifecycleMemory';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const IMAGE_1 = environmentImageName(REPO, ENV_ID, 1);
const OTHER_PID = 999;
const BUSY = { operation: 'rebuild' as const, since: '2026-09-24T15:39:00.000Z', pid: OTHER_PID, windowId: 'window-2' };

let h: Harness;
let asked: number[];

/**
 * A harness whose pipeline asks `processAlive` (as the worker's asks the extension); `alive` answers it, and the
 * registry writes of this window (registryOpenRecords, which the worker sends as requests) ask it synchronously.
 */
function harness(alive: (pid: number) => boolean, overrides: Partial<EnvironmentServiceDeps> = {}, processAlive?: (pid: number) => Promise<boolean>): Harness {
  h?.cleanup();
  asked = [];
  return createHarness({
    isProcessAlive: alive,
    processAlive: async (pid) => {
      asked.push(pid);
      return processAlive ? processAlive(pid) : alive(pid);
    },
    ...overrides,
  });
}

beforeEach(() => {
  h = harness((pid) => pid === PID);
});

afterEach(() => {
  h.cleanup();
});

function options() {
  return { progress: h.progress };
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

const gone = () => new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);

/** The registry refuses every write that sets Environment.lifecycleIncomplete (as B-R4-2 of PR #68). */
function markWritesFail(): void {
  const update = h.registry.updateEnvironment.bind(h.registry);
  h.registry.updateEnvironment = (async (id: string, mutator: (entry: Environment) => void) =>
    update(id, (entry) => {
      const probe = structuredClone(entry);
      mutator(probe);
      if (probe.lifecycleIncomplete !== undefined && entry.lifecycleIncomplete === undefined) throw new Error('registry locked');
      mutator(entry);
    })) as typeof h.registry.updateEnvironment;
}

describe('whether a process of the computer runs, asked before a decision (plan step 11E4d)', () => {
  it('the busy mark of another window: its process is asked; an ended one does not block', async () => {
    h = harness((pid) => pid === PID);
    await seedEnvironment(h, { extra: { busy: BUSY } });
    await h.service.open(TARGET, options());
    expect(asked).toContain(OTHER_PID);
    expect(h.sleeps).toEqual([]);
  });

  it('a running one blocks, and so does one whose answer fails (when in doubt, in use)', async () => {
    for (const answer of [async () => true, async () => Promise.reject(new Error('channel closed'))]) {
      // The registry writes of this window count the process as ended: only the pipeline's question decides here.
      h = harness((pid) => pid === PID, {}, answer);
      await seedEnvironment(h, { extra: { busy: BUSY } });
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('startFailed');
      expect(h.helper.calls).toEqual([]);
      expect((await h.registry.get(ENV_ID))?.busy?.windowId).toBe('window-2');
    }
    expect(h.logger.warnings.join('\n')).toContain(`Whether the process ${OTHER_PID} runs could not be read: channel closed`);
  });

  it('the windows connected to the environment: the process of each status file is asked; one that runs keeps the container', async () => {
    const status: WindowStatus = { windowId: 'window-2', pid: OTHER_PID, environmentId: ENV_ID, state: 'active', updatedAt: new Date(T0).toISOString() };
    for (const [alive, kept] of [
      [false, false],
      [true, true],
    ] as const) {
      h = harness((pid) => pid === PID || alive, { windowStatuses: async () => [status] });
      await seedEnvironment(h, { container: 'stopped' });
      h.helper.userCommandsError = gone();
      await rejection(h.service.open(TARGET, options()));
      expect(asked).toContain(OTHER_PID);
      // The container whose lifecycle commands did not run: removed when no other window uses it, else left running.
      expect(h.docker.containersOf(ENV_ID).some((container) => container.state === 'running')).toBe(kept);
    }
  });
});

describe('only the processes that a rule can count are asked, a few at a time (review round 1 of PR #107, A-M1, A-L4)', () => {
  it('of 40 status files, only the active one of another window of the environment is asked, never more than 4 at once', async () => {
    const fresh = new Date(T0).toISOString();
    const statuses: WindowStatus[] = [
      ...Array.from({ length: 40 }, (_, i) => ({ windowId: `w${i}`, pid: 1000 + i, environmentId: i % 2 === 0 ? 'other-environment' : null, state: 'active' as const, updatedAt: fresh })),
      { windowId: 'w-closing', pid: 2000, environmentId: ENV_ID, state: 'closing', updatedAt: fresh },
      { windowId: WINDOW_ID, pid: PID, environmentId: ENV_ID, state: 'active', updatedAt: fresh },
      { windowId: 'w-connected', pid: OTHER_PID, environmentId: ENV_ID, state: 'active', updatedAt: fresh },
    ];
    let open = 0;
    let most = 0;
    h = harness(
      (pid) => pid === PID,
      { windowStatuses: async () => statuses },
      async () => {
        most = Math.max(most, ++open);
        await new Promise((resolve) => setTimeout(resolve, 1));
        open--;
        return false;
      },
    );
    await seedEnvironment(h, { container: 'stopped' });
    h.helper.userCommandsError = gone();
    await rejection(h.service.open(TARGET, options()));
    expect(new Set(asked)).toEqual(new Set([OTHER_PID]));
    expect(most).toBeLessThanOrEqual(4);
  });

  it('ten windows of the environment: all asked, at most 4 at once', async () => {
    const fresh = new Date(T0).toISOString();
    const statuses: WindowStatus[] = Array.from({ length: 10 }, (_, i) => ({ windowId: `w${i}`, pid: 3000 + i, environmentId: ENV_ID, state: 'active' as const, updatedAt: fresh }));
    let open = 0;
    let most = 0;
    h = harness((pid) => pid === PID, { windowStatuses: async () => statuses }, async () => {
      most = Math.max(most, ++open);
      await new Promise((resolve) => setTimeout(resolve, 1));
      open--;
      return false;
    });
    await seedEnvironment(h, { container: 'stopped' });
    h.helper.userCommandsError = gone();
    await rejection(h.service.open(TARGET, options()));
    expect(new Set(asked)).toEqual(new Set(statuses.map((status) => status.pid)));
    expect(most).toBe(4);
  });

  it('a failed answer counts only that process as running; the others of its batch and the later batches are asked (review round 2 of PR #107)', async () => {
    const fresh = new Date(T0).toISOString();
    const statuses: WindowStatus[] = Array.from({ length: 10 }, (_, i) => ({ windowId: `w${i}`, pid: 3000 + i, environmentId: ENV_ID, state: 'active' as const, updatedAt: fresh }));
    h = harness((pid) => pid === PID, { windowStatuses: async () => statuses }, async (pid) => (pid === 3001 ? Promise.reject(new Error('channel busy')) : false));
    await seedEnvironment(h, { container: 'stopped' });
    h.helper.userCommandsError = gone();
    await rejection(h.service.open(TARGET, options()));
    expect(new Set(asked)).toEqual(new Set(statuses.map((status) => status.pid)));
    // The window of that process counts as connected: the container is left running.
    expect(h.docker.containersOf(ENV_ID).some((container) => container.state === 'running')).toBe(true);
    expect(h.logger.warnings.filter((line) => line.includes('could not be read: channel busy'))).toEqual(['Whether the process 3001 runs could not be read: channel busy']);
  });

  it('the mark of this window\'s process is never asked about', async () => {
    await seedEnvironment(h, { extra: { busy: { ...BUSY, pid: PID, windowId: 'window-old' } } });
    await h.service.open(TARGET, options());
    expect(asked).not.toContain(PID);
  });
});

describe("the window's memory of a container whose lifecycle mark could not be recorded (plan step 11E4d)", () => {
  function memory(): LifecycleMemory & { calls: string[] } {
    const inner = windowLifecycleMemory();
    const calls: string[] = [];
    return {
      calls,
      get: async (id) => (calls.push(`get ${id}`), inner.get(id)),
      remember: async (id, container) => (calls.push(`remember ${id} ${container}`), inner.remember(id, container)),
      forget: async (id, container) => (calls.push(`forget ${id} ${container}`), inner.forget(id, container)),
    };
  }

  it('a running container that the memory names is not opened as it is: `up` and its lifecycle commands run, then it is forgotten', async () => {
    const remembered = memory();
    h = harness((pid) => pid === PID, { lifecycleMemory: remembered });
    await seedEnvironment(h, { container: 'running' });
    const container = h.docker.containersOf(ENV_ID)[0];
    await remembered.remember(ENV_ID, container.id);
    h.settings.updateImagesOnConnect = false;
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(remembered.calls).toEqual([`remember ${ENV_ID} ${container.id}`, `get ${ENV_ID}`, `forget ${ENV_ID} ${container.id}`]);
    expect(await remembered.get(ENV_ID)).toBeUndefined();
    // Without it, the next open opens the container as it is.
    h.helper.calls.length = 0;
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
  });

  it('the memory of another container of the environment does not count, and stays', async () => {
    const remembered = memory();
    h = harness((pid) => pid === PID, { lifecycleMemory: remembered });
    await seedEnvironment(h, { container: 'running' });
    await remembered.remember(ENV_ID, 'f'.repeat(64));
    h.settings.updateImagesOnConnect = false;
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(await remembered.get(ENV_ID)).toBe('f'.repeat(64));
  });

  it('a memory that cannot be read refuses the open before anything is changed', async () => {
    h = harness((pid) => pid === PID, {
      lifecycleMemory: { ...windowLifecycleMemory(), get: async () => Promise.reject(new Error('channel closed')) },
    });
    await seedEnvironment(h, { container: 'running' });
    await expect(h.service.open(TARGET, options())).rejects.toThrow('channel closed');
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ state: 'running' })]);
  });

  it('the mark cannot be recorded: the window remembers the container through its memory; a failure of the memory is logged, the warning stays', async () => {
    for (const fails of [false, true]) {
      const remembered = memory();
      const lifecycleMemory: LifecycleMemory = fails ? { ...remembered, remember: async () => Promise.reject(new Error('channel closed')) } : remembered;
      h = harness((pid) => pid === PID, { lifecycleMemory });
      await seedEnvironment(h, { container: 'stopped' });
      const container = h.docker.containersOf(ENV_ID)[0];
      h.helper.userCommandsError = gone();
      h.docker.stopContainer = async () => {
        throw new Error('Cannot connect to the Docker daemon');
      };
      markWritesFail();
      await rejection(h.service.open(TARGET, options()));
      expect(h.ui.warnings).toEqual([Messages.lifecycleNotRecorded(REPO)]);
      if (fails) {
        expect(h.logger.warnings.join('\n')).toContain('The window could not remember the container');
        expect(await remembered.get(ENV_ID)).toBeUndefined();
      } else {
        expect(await remembered.get(ENV_ID)).toBe(container.id);
      }
    }
  });
});

describe('the owner of the window is never asked about (plan step 11E4d)', () => {
  it('the own busy mark of a crashed open of this window is taken over without asking', async () => {
    await seedEnvironment(h, { extra: { busy: { ...BUSY, pid: PID, windowId: WINDOW_ID } } });
    await h.service.open(TARGET, options());
    expect(h.sleeps).toEqual([]);
  });
});
