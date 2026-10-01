// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR C: the batch scope of the opens in the environment service. Start, Rebuild, Select configuration, Clone
// again and a first open run their helper steps in the batch scope of the volume of the environment (batchScope.ts),
// opened under the held lock and closed before its release: on success, on a failure, and on a cancel; before the
// removal of the volume (a failed first open) its session is closed first. Outside an open (Delete's Git summary, the
// listing of configurations) there is no scope. The token write into the dev container uses the secret input of the
// call (Q4: through the worker that holds the lock). The FakeHelper does not route itself; each of its volume steps
// runs one step of the scope here, as WorkspaceHelper does.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import { UserFacingError } from '../errors';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { currentBatchScope } from '../helper/batchScope';
import { abortError, type RunResult } from '../ports';
import type { RepositoryTarget } from './environmentService';
import { ENV_ID, REPO, TOKEN, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';
import { resourceName } from '../names';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const VOLUME = resourceName(REPO, ENV_ID);
/** The volume steps of the FakeHelper (each one a step of the batch helper in WorkspaceHelper). */
const VOLUME_STEPS = [
  'clone',
  'readConfigFiles',
  'listConfigurations',
  'readConfiguration',
  'build',
  'composeModel',
  'composeServiceHashes',
  'createRepositoryFolders',
  'up',
  'runUserCommands',
  'prepareGit',
  'fixConfigOwnership',
] as const;

let h: Harness;
/** In order: `lock`, `open <session>`, `step <name> <session>`, `close <session>`, `docker volume rm`, `release`. */
let events: string[];
/** Each volume step of the FakeHelper: its name and the volume of the scope it ran in (or `none`). */
let scopes: string[];
/** Runs before each step of a session (for a cancel during a step). */
let onStep: ((name: string) => void) | undefined;

function batchLock(environmentId: string): HeldEnvironmentLock {
  let sessions = 0;
  return {
    environmentId,
    lost: new Promise(() => {}),
    docker: async () => {
      throw new Error('The fake Docker of the service runs no call through the worker.');
    },
    batch: async (p) => {
      const session = `s${++sessions}`;
      events.push(`open ${session} ${p.volume}`);
      const handle: HelperBatchSession = {
        session,
        lost: new Promise(() => {}),
        step: async (kind, _params, options: BatchStepOptions = {}): Promise<RunResult> => {
          onStep?.(kind);
          if (options.signal?.aborted) throw abortError();
          events.push(`step ${kind} ${session}`);
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
        close: async () => {
          events.push(`close ${session}`);
        },
      };
      return handle;
    },
    release: async () => {
      events.push('release');
    },
  };
}

beforeEach(() => {
  events = [];
  scopes = [];
  onStep = undefined;
  h = createHarness({
    environmentLock: async (environmentId) => {
      events.push('lock');
      return batchLock(environmentId);
    },
  });
  const helper = h.helper as unknown as Record<string, (p: { volumeName: string; signal?: AbortSignal }) => Promise<unknown>>;
  for (const name of VOLUME_STEPS) {
    const original = helper[name].bind(h.helper);
    helper[name] = async (p) => {
      const scope = currentBatchScope();
      scopes.push(`${name} ${scope?.volume ?? 'none'}`);
      // As WorkspaceHelper.runInBatch: the step goes to the session of the scope (opened at the first step).
      if (scope !== undefined) {
        await scope.step({ volume: p.volumeName, kind: 'listConfigs', params: {}, options: { signal: p.signal } }, async () => ({ image: `sha256:${'4'.repeat(64)}`, socket: '/var/run/docker.sock' }));
      }
      return original(p);
    };
  }
  const removeVolume = h.docker.removeVolume.bind(h.docker);
  h.docker.removeVolume = async (name) => {
    events.push('docker volume rm');
    return removeVolume(name);
  };
});

afterEach(() => h.cleanup());

/** The events without the steps (one session, its open and close, and what came around them). */
function frame(): string[] {
  return events.filter((event) => !event.startsWith('step '));
}

describe('the batch scope of the opens (plan step 6, PR C)', () => {
  it('Start: every helper step runs in the scope of the volume, in one session, closed before the lock is released', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((scope) => scope.endsWith(` ${VOLUME}`))).toBe(true);
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
    expect(currentBatchScope()).toBeUndefined();
  });

  it('Rebuild: one session for the build and `up`', async () => {
    await seedEnvironment(h, { container: 'running' });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress, forceRebuild: true });
    expect(scopes).toEqual(expect.arrayContaining([`build ${VOLUME}`, `up ${VOLUME}`]));
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
  });

  it('a failed step closes the session before the release', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.helper.readConfigurationError = new Error('read failed');
    await h.service.openEnvironment(ENV_ID, { progress: h.progress }).catch(() => undefined);
    expect(frame().slice(-2)).toEqual(['close s1', 'release']);
    expect(frame().filter((event) => event.startsWith('open'))).toHaveLength(1);
  });

  it('a cancel during a step closes the session before the release', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    const controller = new AbortController();
    onStep = () => controller.abort();
    const error = await h.service.openEnvironment(ENV_ID, { progress: h.progress, signal: controller.signal }).then(
      () => undefined,
      (reason: unknown) => reason as UserFacingError,
    );
    expect(error?.code).toBe('cancelled');
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
  });

  it('first open: the session opens after the volume exists; a failed clone closes it before the volume is removed', async () => {
    h.helper.cloneError = new Error('Repository not found');
    await h.service.open(TARGET, { progress: h.progress }).catch(() => undefined);
    const [open] = frame().filter((event) => event.startsWith('open'));
    const volume = open.split(' ')[2];
    expect(h.docker.volumes.has(volume)).toBe(false);
    expect(frame()).toEqual(['lock', open, 'close s1', 'docker volume rm', 'release']);
    expect(scopes).toEqual([`clone ${volume}`]);
  });

  it('Clone again: the session opens at the clone, after the new volume', async () => {
    await seedEnvironment(h, { volume: false, container: null });
    h.ui.filesMissingAnswer = 'cloneAgain';
    await h.service.open(TARGET, { progress: h.progress });
    expect(scopes[0]).toBe(`clone ${VOLUME}`);
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
  });

  it('no scope outside an open: the Git summary of Delete and the listing of configurations (plan step 7)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    await h.service.listConfigurations(ENV_ID, { progress: h.progress });
    expect(scopes).toEqual(['listConfigurations none']);
    expect(events).toEqual([]);
  });

  it('Q4: the token goes into the dev container as the secret input of the exec, never in its command', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    const writes = h.docker.execs.filter((exec) => exec.input === TOKEN);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.secret).toBe(true);
      expect(write.command.some((arg) => arg.includes(TOKEN))).toBe(false);
    }
  });
});
