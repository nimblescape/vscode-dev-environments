// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #107 (plan step 11E4d), reviewer B: the probes of the mutation testing of the pipeline's
// questions to the window (processAlive before each decision about the other windows, and the window's lifecycle memory).
import { afterEach, describe, expect, it } from 'vitest';
import { CommandError, UserFacingError } from '../errors';
import { Messages } from '../messages';
import { LABEL_CONTAINER_VERSION, environmentImageName } from '../names';
import type { Environment, WindowStatus } from '../types';
import type { ComposeModel } from '../helper/composeModel';
import type { ComposeModelOutput } from '../helper/compose';
import type { RepositoryTarget } from './operationBase';
import { BASE_IMAGE, DIGEST_NEW, ENV_ID, FEATURE, FEATURE_DIGEST, PID, REPO, T0, checked, createHarness, seedEnvironment, type Harness, type HarnessOverrides } from './environmentService.testkit';
import { composeProjectName } from '../names';
import { windowLifecycleMemory, type LifecycleMemory } from './lifecycleMemory';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const IMAGE_1 = environmentImageName(REPO, ENV_ID, 1);
const WINDOW_B = 'window-b';
const PID_B = 7171;

let h: Harness | undefined;
let asked: number[] = [];

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

/**
 * A harness whose synchronous isProcessAlive knows only this window's process (as the worker, which knows none), while
 * the pipeline's question (processAlive, which the worker sends to the extension) says `alive`.
 */
function harness(alive: (pid: number) => boolean, overrides: HarnessOverrides = {}): Harness {
  h?.cleanup();
  asked = [];
  h = createHarness({
    isProcessAlive: (pid) => pid === PID,
    processAlive: async (pid) => {
      asked.push(pid);
      return alive(pid);
    },
    ...overrides,
  });
  return h;
}

function options() {
  return { progress: h!.progress };
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
const statusOfB = (ageMs = 0, pid = PID_B, windowId = WINDOW_B): WindowStatus => ({
  windowId,
  pid,
  environmentId: ENV_ID,
  state: 'active',
  updatedAt: new Date(T0 - ageMs).toISOString(),
});
const ups = () => h!.helper.calls.filter((call) => call.startsWith('up'));

/** The registry refuses every write that sets Environment.lifecycleIncomplete (as B-R4-2 of PR #68). */
function markWritesFail(): void {
  const registry = h!.registry;
  const update = registry.updateEnvironment.bind(registry);
  registry.updateEnvironment = (async (id: string, mutator: (entry: Environment) => void) =>
    update(id, (entry) => {
      const probe = structuredClone(entry);
      mutator(probe);
      if (probe.lifecycleIncomplete !== undefined && entry.lifecycleIncomplete === undefined) throw new Error('registry locked');
      mutator(entry);
    })) as typeof registry.updateEnvironment;
}

/** A memory over windowLifecycleMemory that records its calls; `delayMs` delays each change by a timer. */
function memory(delayMs = 0, failForget = false): LifecycleMemory & { calls: string[]; inner: LifecycleMemory } {
  const inner = windowLifecycleMemory();
  const calls: string[] = [];
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  return {
    calls,
    inner,
    get: async (id) => (calls.push(`get ${id}`), inner.get(id)),
    remember: async (id, container) => {
      calls.push(`remember ${id} ${container}`);
      if (delayMs > 0) await later();
      await inner.remember(id, container);
    },
    forget: async (id, container) => {
      calls.push(`forget ${id} ${container}`);
      if (delayMs > 0) await later();
      if (failForget) throw new Error('channel closed');
      await inner.forget(id, container);
    },
  };
}

describe('review round 1 of PR #107 (B): the answer of processAlive decides, never the synchronous isProcessAlive', () => {
  it('rule 1 (otherWindowUsesEnvironment): a connected window whose process the extension says runs keeps the container', async () => {
    harness((pid) => pid === PID || pid === PID_B, { windowStatuses: async () => [statusOfB()] });
    await seedEnvironment(h!, { container: 'stopped' });
    h!.helper.userCommandsError = gone();
    await rejection(h!.service.open(TARGET, options()));
    expect(asked).toContain(PID_B);
    expect(h!.docker.containersOf(ENV_ID).map((container) => container.state)).toEqual(['running']);
  });

  it('rule 2 (otherWindowMayUseEnvironment): a late status file of a window whose process the extension says runs is "not known"', async () => {
    harness((pid) => pid === PID || pid === PID_B, { windowStatuses: async () => [statusOfB(75_000)] });
    await seedEnvironment(h!, { container: 'running', containerLabels: { [LABEL_CONTAINER_VERSION]: '0' } });
    const error = await rejection(h!.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('it could not be checked whether another window uses the environment');
    expect(ups()).toEqual([]);
    expect(h!.logger.warnings.join('\n')).toContain(`The window ${WINDOW_B} (process ${PID_B}) last wrote its status at`);
  });

  it('a process is asked once per decision, also when two status files name it', async () => {
    const inFlight = new Set<number>();
    const twice: number[] = [];
    h?.cleanup();
    asked = [];
    h = createHarness({
      isProcessAlive: (pid) => pid === PID,
      windowStatuses: async () => [statusOfB(), statusOfB(0, PID_B, 'window-c')],
      processAlive: async (pid) => {
        asked.push(pid);
        if (inFlight.has(pid)) twice.push(pid);
        inFlight.add(pid);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight.delete(pid);
        return pid === PID || pid === PID_B;
      },
    });
    await seedEnvironment(h, { container: 'stopped' });
    h.helper.userCommandsError = gone();
    await rejection(h.service.open(TARGET, options()));
    expect(asked).toContain(PID_B);
    expect(twice).toEqual([]);
  });
});

describe("review round 1 of PR #107 (B): the window's lifecycle memory", () => {
  it('the memory is changed before the open ends: remember (another window uses the container)', async () => {
    const remembered = memory(30);
    harness((pid) => pid === PID || pid === PID_B, { lifecycleMemory: remembered, windowStatuses: async () => [statusOfB()] });
    await seedEnvironment(h!, { container: 'stopped' });
    const container = h!.docker.containersOf(ENV_ID)[0];
    h!.helper.userCommandsError = gone();
    markWritesFail();
    await rejection(h!.service.open(TARGET, options()));
    expect(h!.ui.warnings).toEqual([Messages.lifecycleNotRecorded(REPO)]);
    expect(await remembered.inner.get(ENV_ID)).toBe(container.id);
  });

  it('the memory is changed before the open ends: forget after the lifecycle commands ran', async () => {
    const remembered = memory(30);
    harness((pid) => pid === PID, { lifecycleMemory: remembered });
    await seedEnvironment(h!, { container: 'running' });
    const container = h!.docker.containersOf(ENV_ID)[0];
    await remembered.inner.remember(ENV_ID, container.id);
    h!.settings.updateImagesOnConnect = false;
    await h!.service.open(TARGET, options());
    expect(ups()).toEqual([`up ${IMAGE_1}`]);
    expect(await remembered.inner.get(ENV_ID)).toBeUndefined();
  });

  it('a memory that cannot forget does not fail the open: logged, and the environment opens', async () => {
    const remembered = memory(0, true);
    harness((pid) => pid === PID, { lifecycleMemory: remembered });
    await seedEnvironment(h!, { container: 'running' });
    const container = h!.docker.containersOf(ENV_ID)[0];
    await remembered.inner.remember(ENV_ID, container.id);
    h!.settings.updateImagesOnConnect = false;
    const result = await h!.service.open(TARGET, options());
    expect(result.containerName).toBe(container.name);
    expect(h!.logger.warnings.join('\n')).toContain(`The window could not forget the container ${container.id}: channel closed`);
  });

  it('nothing remembered: the lifecycle commands ran, and the memory is only read (no forget request)', async () => {
    const remembered = memory();
    harness((pid) => pid === PID, { lifecycleMemory: remembered });
    await seedEnvironment(h!, { container: 'stopped' });
    await h!.service.open(TARGET, options());
    expect(h!.helper.userCommandRuns.length).toBeGreaterThan(0);
    expect(remembered.calls).toEqual([`get ${ENV_ID}`]);
  });

  it('another container remembered: the lifecycle commands of this one ran, and the memory is not asked to forget', async () => {
    const remembered = memory();
    harness((pid) => pid === PID, { lifecycleMemory: remembered });
    await seedEnvironment(h!, { container: 'stopped' });
    await remembered.inner.remember(ENV_ID, 'f'.repeat(64));
    await h!.service.open(TARGET, options());
    expect(h!.helper.userCommandRuns.length).toBeGreaterThan(0);
    expect(remembered.calls).toEqual([`get ${ENV_ID}`]);
    expect(await remembered.inner.get(ENV_ID)).toBe('f'.repeat(64));
  });

  it('Docker Compose: a dev container remembered in this run and then removed by the cleanup of the switch is forgotten', async () => {
    const PROJECT = composeProjectName(REPO, ENV_ID);
    const DB_IMAGE = 'postgres:16';
    const CONFIG_TEXT = `{
  "name": "API",
  "dockerComposeFile": ["compose.yml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
  "features": { "${FEATURE}": {} },
  "remoteUser": "vscode"
}`;
    const model: ComposeModel = {
      name: PROJECT,
      services: {
        app: { image: BASE_IMAGE, command: ['sleep', 'infinity'], networks: { default: null } },
        db: { image: DB_IMAGE, networks: { default: null } },
      },
      networks: { default: { name: `${PROJECT}_default` } },
    } as ComposeModel;
    const output: ComposeModelOutput = { version: '2.40.3', dollarEscaped: true, model, dockerfiles: {}, realPaths: {}, inputsHash: 'inputs-1' } as ComposeModelOutput;
    const remembered = memory();
    harness((pid) => pid === PID, { lifecycleMemory: remembered, newEnvironmentId: () => ENV_ID });
    h!.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT } };
    h!.helper.composeOutput = output;
    h!.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: `sha256:${'d'.repeat(64)}` }, { [FEATURE]: FEATURE_DIGEST });
    await seedEnvironment(h!, { container: 'stopped' });
    h!.docker.images.add(DB_IMAGE);
    h!.ui.configurationChangedAnswer = 'rebuildNow';
    const remove = h!.docker.removeContainer.bind(h!.docker);
    const stop = h!.docker.stopContainer.bind(h!.docker);
    h!.docker.removeContainer = async (ref) => {
      if (new Error().stack?.includes('withdrawAfterHelperFailed')) throw new CommandError('docker rm', 1, '', 'Cannot connect to the Docker daemon');
      return remove(ref);
    };
    h!.docker.stopContainer = async (ref) => {
      if (new Error().stack?.includes('withdrawAfterHelperFailed')) throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
      return stop(ref);
    };
    h!.helper.userCommandsError = gone();
    markWritesFail();
    const error = await rejection(h!.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h!.docker.containersOf(ENV_ID)).toEqual([]);
    const rememberCall = remembered.calls.find((call) => call.startsWith('remember '));
    expect(rememberCall).toBeDefined();
    const id = rememberCall!.split(' ')[2];
    expect(remembered.calls).toContain(`forget ${ENV_ID} ${id}`);
    expect(await remembered.inner.get(ENV_ID)).toBeUndefined();
  });
});
