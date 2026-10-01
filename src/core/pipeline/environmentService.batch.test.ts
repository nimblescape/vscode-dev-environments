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
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import { UserFacingError } from '../errors';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { currentBatchScope } from '../helper/batchScope';
import { abortError, isAbortError, silentLogger, type RunResult } from '../ports';
import { batchStepCommand, type BatchStepKind } from '../helper/batchSteps';
import { composeProjectName } from '../names';
import { WorkspaceHelper, type HelperDocker, type HelperImageUse } from '../helper/workspaceHelper';
import type { RepositoryTarget } from './environmentService';
import { BASE_IMAGE, DIGEST_NEW, ENV_ID, REPO, TOKEN, checked, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';
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
/** Review round 1 of PR #82 (B-R1-2): runs when a close starts; the close settles after `closeGate`. */
let onClose: (() => void) | undefined;
let closeGate: Promise<void> | undefined;
/** Review round 1 of PR #82 (B-R1-4): each step of a session, with its kind and parameters. */
let recorded: Array<{ kind: BatchStepKind; params: unknown }>;
/**
 * Review round 1 of PR #82 (B-R1-4): when set, each volume step of the FakeHelper runs as the real WorkspaceHelper runs
 * it in the scope (with the parameters that the service passes), instead of one `listConfigs` step.
 */
let realHelper: WorkspaceHelper | undefined;
const PINNED: HelperImageUse = { tag: 'devenv-helper:test', id: `sha256:${'4'.repeat(64)}` };

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
        step: async (kind, params, options: BatchStepOptions = {}): Promise<RunResult> => {
          recorded.push({ kind, params });
          onStep?.(kind);
          if (options.signal?.aborted) throw abortError();
          events.push(`step ${kind} ${session}`);
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
        close: async () => {
          onClose?.();
          await closeGate;
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
  onClose = undefined;
  closeGate = undefined;
  recorded = [];
  realHelper = undefined;
  h = createHarness({
    newEnvironmentId: () => ENV_ID,
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
      if (scope !== undefined && realHelper !== undefined) {
        const real = realHelper as unknown as Record<string, (p: unknown) => Promise<unknown>>;
        // Its result is not used (the FakeHelper answers); a refusal or a cancel goes on as in WorkspaceHelper.
        // The fake containers have IDs of their own; Docker's are hexadecimal.
        const ids = 'containerId' in p ? { containerId: createHash('sha256').update(String(p.containerId)).digest('hex') } : {};
        await real[name]({ ...p, ...ids, image: PINNED }).catch((error: unknown) => {
          if (error instanceof UserFacingError || isAbortError(error)) throw error;
        });
      } else if (scope !== undefined) {
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

  // Review round 1 of PR #82: the tests of reviewer B (mutation testing).

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  /** One turn of the event loop (no timer). */
  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('review round 1 of PR #82, B-R1-2: the lock is released only after the close of the session settled', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    const closing = deferred();
    const gate = deferred();
    onClose = closing.resolve;
    closeGate = gate.promise;
    const run = h.service.openEnvironment(ENV_ID, { progress: h.progress });
    await closing.promise;
    await turn();
    expect(events).not.toContain('release');
    gate.resolve();
    await run;
    expect(frame()).toEqual(['lock', `open s1 ${VOLUME}`, 'close s1', 'release']);
  });

  it('review round 1 of PR #82, B-R1-2: a failed first open removes the volume only after the close of the session settled', async () => {
    h.helper.cloneError = new Error('Repository not found');
    const closing = deferred();
    const gate = deferred();
    onClose = closing.resolve;
    closeGate = gate.promise;
    const run = h.service.open(TARGET, { progress: h.progress }).catch(() => undefined);
    await closing.promise;
    await turn();
    expect(events).not.toContain('docker volume rm');
    gate.resolve();
    await run;
    const [open] = frame().filter((event) => event.startsWith('open'));
    expect(frame()).toEqual(['lock', open, 'close s1', 'docker volume rm', 'release']);
  });

  /** A HelperDocker for the real WorkspaceHelper: in the scope it runs nothing. */
  const noDocker: HelperDocker = {
    run: async () => {
      throw new Error('A docker run in the scope.');
    },
    imageExists: async () => true,
    imageId: async () => PINNED.id,
    buildImage: async () => PINNED.id,
    listImagesByLabel: async () => [],
    removeImage: async () => true,
  };

  const COMPOSE_CONFIG = `{
  "name": "API",
  "dockerComposeFile": ["compose.yml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}"
}`;

  const opens: Array<[string, () => Promise<unknown>, BatchStepKind[]]> = [
    ['single container (first open)', () => h.service.open(TARGET, { progress: h.progress }), ['clone', 'readConfiguration', 'build', 'up', 'gitFiles', 'runUserCommands']],
    [
      'Docker Compose (first open)',
      () => {
        h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: COMPOSE_CONFIG } };
        h.helper.composeOutput = {
          version: '2.40.3',
          dollarEscaped: true,
          model: { name: composeProjectName(ENV_ID), services: { app: { image: BASE_IMAGE, command: ['sleep', 'infinity'] } } },
          dockerfiles: {},
          realPaths: {},
          inputsHash: 'inputs-1',
        };
        h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW });
        return h.service.open(TARGET, { progress: h.progress });
      },
      ['clone', 'readConfiguration', 'composeModel', 'build', 'up'],
    ],
    [
      'Rebuild',
      async () => {
        await seedEnvironment(h, { container: 'running' });
        return h.service.openEnvironment(ENV_ID, { progress: h.progress, forceRebuild: true });
      },
      ['readConfiguration', 'build', 'up', 'runUserCommands'],
    ],
    [
      'Clone again',
      async () => {
        await seedEnvironment(h, { volume: false, container: null });
        h.ui.filesMissingAnswer = 'cloneAgain';
        return h.service.open(TARGET, { progress: h.progress });
      },
      ['clone', 'readConfiguration', 'up', 'runUserCommands'],
    ],
  ];
  for (const [name, open, kinds] of opens) {
    it(`review round 1 of PR #82, B-R1-4: every step of a whole open is one the batch helper accepts (batchStepCommand): ${name}`, async () => {
      realHelper = new WorkspaceHelper({ docker: noDocker, logger: silentLogger, dockerfilePath: '/nonexistent/Dockerfile', env: {}, platform: 'linux' });
      await open();
      expect(frame().filter((event) => event.startsWith('open '))).toHaveLength(1);
      expect(recorded.map((step) => step.kind)).toEqual(expect.arrayContaining(kinds));
      for (const step of recorded) expect(() => batchStepCommand(step.kind, step.params), step.kind).not.toThrow();
    });
  }
});
