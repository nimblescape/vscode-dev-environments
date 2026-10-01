// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR C: the batch scope of an open (batchScope.ts) and the routing of WorkspaceHelper into it. Checked: within
// the scope every volume step goes to the one session of the held lock (with the inputs of its builder) and never to a
// `docker run`; the token goes only in the `secret` field; a session that cannot be opened, a lock without `batch`, a run
// without a batch kind and a step for another volume refuse (D1) and run nothing; a session that ended between two steps
// is replaced once under the same lock, a failed reopen refuses; a step that fails because its session was lost fails
// the operation and is never repeated; the session is closed on success, failure and cancel; outside the scope the
// per-step run is unchanged.
import { describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import { UserFacingError } from '../errors';
import { HelperChannelError, type BatchStepOptions, type HelperBatchSession } from '../helperChannel/helperChannel';
import { Messages } from '../messages';
import { abortError, silentLogger, type RunOptions, type RunResult } from '../ports';
import type { BatchStepKind } from './batchSteps';
import { currentBatchScope, runWithBatchScope } from './batchScope';
import { WorkspaceHelper, type HelperDocker, type HelperImageUse } from './workspaceHelper';

const TOKEN = 'gho_0123456789abcdefSECRET';
const VOLUME = 'devenv-acme-app-3f2a9c1e';
const ENVIRONMENT_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const IMAGE: HelperImageUse = { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` };

interface StepCall {
  session: string;
  kind: BatchStepKind;
  params: unknown;
  options: BatchStepOptions;
}

/** A batch session of the fake lock: records its steps; `end` ends it as lost. */
class FakeSession implements HelperBatchSession {
  readonly lost: Promise<string>;
  closed = 0;
  end!: (reason: string) => void;
  constructor(
    readonly session: string,
    private readonly world: FakeLock,
  ) {
    this.lost = new Promise((resolve) => (this.end = resolve));
  }
  async step(kind: BatchStepKind, params: unknown, options: BatchStepOptions = {}): Promise<RunResult> {
    this.world.steps.push({ session: this.session, kind, params, options });
    return this.world.stepResult(kind, this);
  }
  async close(): Promise<void> {
    this.closed++;
    this.world.events.push(`close ${this.session}`);
  }
}

/** A held lock whose `batch` opens FakeSessions (or fails with `openError`). */
class FakeLock implements HeldEnvironmentLock {
  readonly environmentId = ENVIRONMENT_ID;
  readonly lost = new Promise<string>(() => {});
  readonly sessions: FakeSession[] = [];
  readonly opens: Array<{ volume: string; image: string; socket: string }> = [];
  readonly steps: StepCall[] = [];
  readonly events: string[] = [];
  openError: Error | undefined;
  stepResult: (kind: BatchStepKind, session: FakeSession) => Promise<RunResult> = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
  async docker(): Promise<RunResult> {
    throw new Error('not used');
  }
  async release(): Promise<void> {}
  batch = async (p: { volume: string; image: string; socket: string }): Promise<HelperBatchSession> => {
    this.opens.push(p);
    if (this.openError) throw this.openError;
    const session = new FakeSession(`s${this.sessions.length + 1}`, this);
    this.sessions.push(session);
    this.events.push(`open ${session.session}`);
    return session;
  };
}

/** A HelperDocker that records every call; a `docker run` within the scope fails the test. */
class RecordingDocker implements HelperDocker {
  readonly runs: Array<{ args: readonly string[]; options: RunOptions }> = [];
  async run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.runs.push({ args, options });
    return { exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false };
  }
  async imageExists(): Promise<boolean> {
    return true;
  }
  async imageId(): Promise<string | undefined> {
    return IMAGE.id;
  }
  async buildImage(): Promise<string | undefined> {
    return IMAGE.id;
  }
  async listImagesByLabel() {
    return [];
  }
  async removeImage(): Promise<boolean> {
    return true;
  }
}

function setup() {
  const docker = new RecordingDocker();
  const helper = new WorkspaceHelper({ docker, logger: silentLogger, dockerfilePath: '/nonexistent/Dockerfile', env: {}, platform: 'linux' });
  const lock = new FakeLock();
  return { docker, helper, lock };
}

async function refusal(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

describe('the batch scope of an open (plan step 6, PR C)', () => {
  it('runs every volume step in the one session of the held lock, never as a docker run, with the inputs of its builder', async () => {
    const { docker, helper, lock } = setup();
    lock.stepResult = async (kind) => ({
      exitCode: 0,
      stdout:
        kind === 'listConfigs'
          ? '[".devcontainer/devcontainer.json"]\n'
          : kind === 'readFiles'
            ? '{"configText":"{}"}\n'
            : kind === 'readConfiguration'
              ? '{"configuration":{"image":"x"}}\n'
              : kind === 'up' || kind === 'build' || kind === 'runUserCommands'
                ? '{"outcome":"success","containerId":"0123456789ab"}\n'
                : kind === 'composeModel'
                  ? '{"error":"none"}\n'
                  : '',
      stderr: '',
      timedOut: false,
    });
    const folder = '/workspaces/app';
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.clone({ volumeName: VOLUME, repository: 'acme/app', branch: 'main', token: TOKEN, image: IMAGE });
      await helper.readConfigFiles({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', image: IMAGE });
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      await helper.readConfiguration({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', environmentId: ENVIRONMENT_ID, merged: false, env: { COMPOSE_PROJECT_NAME: 'p', DOCKER_HOST: 'tcp://x' }, image: IMAGE });
      await helper.build({ volumeName: VOLUME, repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', imageName: 'devenv-3f2a9c1e:1', image: IMAGE });
      await helper.composeModel({ volumeName: VOLUME, repository: 'acme/app', files: [`${folder}/compose.yml`], project: 'p', image: IMAGE });
      await helper.composeServiceHashes({ volumeName: VOLUME, repository: 'acme/app', model: '{}', project: 'p', image: IMAGE });
      await helper.createRepositoryFolders({ volumeName: VOLUME, repository: 'acme/app', folders: [`${folder}/data`], image: IMAGE });
      await helper.up({ volumeName: VOLUME, repository: 'acme/app', override: {}, environmentId: ENVIRONMENT_ID, removeExistingContainer: false, token: TOKEN, image: IMAGE });
      await helper.runUserCommands({ volumeName: VOLUME, repository: 'acme/app', override: {}, environmentId: ENVIRONMENT_ID, containerId: '0123456789ab', token: TOKEN, image: IMAGE });
      await helper.prepareGit({ volumeName: VOLUME, repository: 'acme/app', identity: { name: 'Octo', email: 'octo@example.com' }, image: IMAGE });
      await helper.fixConfigOwnership({ volumeName: VOLUME, folder: '/workspaces/.devenv+', uid: '1000', gid: '1000', timeoutMs: 5000, image: IMAGE });
    });
    expect(docker.runs).toEqual([]);
    expect(lock.opens).toEqual([{ volume: VOLUME, image: IMAGE.id, socket: '/var/run/docker.sock' }]);
    expect(lock.steps.map((step) => `${step.session} ${step.kind}`)).toEqual([
      's1 clone',
      's1 readFiles',
      's1 listConfigs',
      's1 readConfiguration',
      's1 build',
      's1 composeModel',
      's1 composeHash',
      's1 createFolders',
      's1 up',
      's1 runUserCommands',
      's1 gitFiles',
      's1 ownershipFix',
    ]);
    const byKind = Object.fromEntries(lock.steps.map((step) => [step.kind, step]));
    // The token: only in the `secret` field (the clone's standard input in the helper; `up` and run-user-commands mask it).
    expect(byKind.clone).toMatchObject({ params: { repository: 'acme/app', branch: 'main' }, options: { secret: TOKEN } });
    for (const step of lock.steps) expect(JSON.stringify(step.params)).not.toContain(TOKEN);
    expect(lock.steps.filter((step) => step.options.secret !== undefined).map((step) => step.kind)).toEqual(['clone', 'up', 'runUserCommands']);
    // The variables pass the checks of `-e` (DOCKER_HOST never), and only to the kinds that take them.
    expect(byKind.readConfiguration.params).toEqual({ repository: 'acme/app', configPath: '.devcontainer/devcontainer.json', environmentId: ENVIRONMENT_ID, merged: false, env: { COMPOSE_PROJECT_NAME: 'p' } });
    expect(byKind.composeModel.params).toEqual({ repository: 'acme/app', files: [`${folder}/compose.yml`], project: 'p' });
    expect(byKind.composeHash.params).toEqual({ model: '{}', project: 'p' });
    expect(byKind.ownershipFix).toMatchObject({ params: { folder: '/workspaces/.devenv+', uid: '1000', gid: '1000' }, options: { timeoutMs: 5000 } });
    // Closed at the end of the scope.
    expect(lock.events).toEqual(['open s1', 'close s1']);
    expect(currentBatchScope()).toBeUndefined();
  });

  it('runs the per-step docker run outside the scope, unchanged', async () => {
    const { docker, helper } = setup();
    await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
    expect(docker.runs).toHaveLength(1);
    expect(docker.runs[0].args[0]).toBe('run');
  });

  it('D1: a session that cannot be opened refuses the operation with the cause; nothing runs, also not the next step', async () => {
    const { docker, helper, lock } = setup();
    lock.openError = new HelperChannelError('unsendable', 'too many batch helpers');
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      const error = await refusal(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
      expect(error.code).toBe('helperFailed');
      expect(error.message).toBe(Messages.batchHelperUnavailable(`The batch helper on the volume ${VOLUME} could not be opened: too many batch helpers`));
      lock.openError = undefined;
      // The scope refused: a caller that catches the error cannot go on with another step.
      await expect(helper.readConfigFiles({ volumeName: VOLUME, repository: 'acme/app', configPath: 'a.json', image: IMAGE })).rejects.toBe(error);
    });
    expect(lock.opens).toHaveLength(1);
    expect(docker.runs).toEqual([]);
  });

  it('D1: a lock without batch, a run without a batch kind, a step for another volume, and an image without an ID refuse', async () => {
    const cases: Array<[string, (helper: WorkspaceHelper) => Promise<unknown>, (lock: FakeLock) => HeldEnvironmentLock, string]> = [
      ['no batch', (helper) => helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }), (lock) => ({ ...lock, environmentId: lock.environmentId, lost: lock.lost, docker: lock.docker, release: lock.release, batch: undefined }), 'has no batch helper'],
      ['run', (helper) => helper.run(VOLUME, ['sh', '-c', 'true']), (lock) => lock, 'has no step in the batch helper'],
      ['gitSummary', (helper) => helper.gitSummary({ volumeName: VOLUME, repository: 'acme/app' }), (lock) => lock, 'has no step in the batch helper'],
      ['volume', (helper) => helper.listConfigurations({ volumeName: 'other', repository: 'acme/app', image: IMAGE }), (lock) => lock, 'is for the volume other'],
      ['no image ID', (helper) => helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: { tag: IMAGE.tag } }), (lock) => lock, 'the ID of the helper image'],
    ];
    for (const [name, run, held, cause] of cases) {
      const { docker, helper, lock } = setup();
      await runWithBatchScope(held(lock), VOLUME, silentLogger, async () => {
        const error = await refusal(run(helper));
        expect(error.code, name).toBe('helperFailed');
        expect(error.detail, name).toContain(cause);
      });
      expect(docker.runs, name).toEqual([]);
      expect(lock.steps, name).toEqual([]);
    }
  });

  it('a session that ended between two steps (its idle end) is replaced once under the same lock; the step is not repeated', async () => {
    const { docker, helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      lock.sessions[0].end('the helper ended after 15 minutes without a step');
      await Promise.resolve();
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
    });
    expect(lock.steps.map((step) => step.session)).toEqual(['s1', 's2', 's2']);
    expect(lock.events).toEqual(['open s1', 'open s2', 'close s2']);
    expect(docker.runs).toEqual([]);
  });

  it('a failed reopen refuses the operation (D1)', async () => {
    const { docker, helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      lock.sessions[0].end('lost');
      await Promise.resolve();
      lock.openError = new HelperChannelError('lost', 'the worker was lost');
      const error = await refusal(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
      expect(error.detail).toBe(`The batch helper on the volume ${VOLUME} could not be opened again: the worker was lost`);
    });
    expect(lock.opens).toHaveLength(2);
    expect(lock.steps).toHaveLength(1);
    expect(docker.runs).toEqual([]);
  });

  it('a step that fails because its session was lost fails the operation; it is never repeated, and no later step runs', async () => {
    const { docker, helper, lock } = setup();
    lock.stepResult = async (_kind, session) => {
      session.end('the helper was lost');
      throw new HelperChannelError('lost', 'The helper channel was lost.');
    };
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      const error = await refusal(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe('The step listConfigs failed in the batch helper s1: The helper channel was lost.');
      await expect(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE })).rejects.toBe(error);
    });
    expect(lock.opens).toHaveLength(1);
    expect(lock.steps).toHaveLength(1);
    expect(docker.runs).toEqual([]);
  });

  it('closes the session on success, on a failure, and on a cancel', async () => {
    for (const outcome of ['success', 'failure', 'cancel'] as const) {
      const { helper, lock } = setup();
      const controller = new AbortController();
      lock.stepResult = async (kind) => {
        if (outcome === 'cancel' && kind === 'readFiles') {
          controller.abort();
          throw abortError();
        }
        return { exitCode: outcome === 'failure' && kind === 'readFiles' ? 1 : 0, stdout: kind === 'readFiles' ? '{"configText":"{}"}\n' : '["a"]\n', stderr: 'boom', timedOut: false };
      };
      const run = runWithBatchScope(lock, VOLUME, silentLogger, async () => {
        await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE, signal: controller.signal });
        await helper.readConfigFiles({ volumeName: VOLUME, repository: 'acme/app', configPath: 'a.json', image: IMAGE, signal: controller.signal });
      });
      if (outcome === 'success') await expect(run).resolves.toBeUndefined();
      else if (outcome === 'failure') await expect(run).rejects.toMatchObject({ name: 'CommandError' });
      else await expect(run).rejects.toMatchObject({ name: 'AbortError' });
      expect(lock.events, outcome).toEqual(['open s1', 'close s1']);
    }
  });

  it('the time limit of a step is an Error that is no AbortError, and the session stays', async () => {
    const { helper, lock } = setup();
    lock.stepResult = async (kind) => ({ exitCode: kind === 'composeModel' ? null : 0, stdout: '', stderr: '', timedOut: kind === 'composeModel' });
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await expect(helper.composeModel({ volumeName: VOLUME, repository: 'acme/app', files: ['/workspaces/app/c.yml'], project: 'p', timeoutMs: 2000, image: IMAGE })).rejects.toThrow(
        'The step composeModel of the batch helper did not end within 2 seconds.',
      );
      await helper.createRepositoryFolders({ volumeName: VOLUME, repository: 'acme/app', folders: ['/workspaces/app/d'], image: IMAGE });
    });
    expect(lock.steps.map((step) => `${step.session} ${step.kind}`)).toEqual(['s1 composeModel', 's1 createFolders']);
    expect(lock.steps[0].options.timeoutMs).toBe(2000);
  });

  it('closeSession ends the session before the volume is removed; a later step opens a new one', async () => {
    const { helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      await currentBatchScope()!.closeSession();
      lock.events.push('volume rm');
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
    });
    expect(lock.events).toEqual(['open s1', 'close s1', 'volume rm', 'open s2', 'close s2']);
  });

  // Review round 1 of PR #82 (A-R1-5): the lock lost while a step runs closes the session, which ends that step; the step
  // fails the operation, and no later step runs.
  it('closes the session when the lock is lost, so the running step ends and the scope refuses', async () => {
    const { docker, helper, lock } = setup();
    let loseLock!: (reason: string) => void;
    Object.assign(lock, { lost: new Promise<string>((resolve) => (loseLock = resolve)) });
    let closedDuringStep = false;
    lock.stepResult = async (_kind, session) => {
      loseLock('its hold limit was reached');
      for (let i = 0; i < 100 && session.closed === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
      closedDuringStep = session.closed > 0;
      throw new HelperChannelError('lost', 'The batch helper was closed.');
    };
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      const error = await refusal(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE }));
      expect(error.code).toBe('helperFailed');
      await expect(helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE })).rejects.toBe(error);
    });
    expect(closedDuringStep).toBe(true);
    expect(lock.opens).toHaveLength(1);
    expect(lock.steps).toHaveLength(1);
    expect(docker.runs).toEqual([]);
  });

  // Review round 1 of PR #82 (A-R1-6): a step queued while end() closes the session is refused; it never opens a new
  // session that nothing would close.
  it('refuses a step that is queued while the scope ends, and opens no new session', async () => {
    const { helper, lock } = setup();
    lock.stepResult = async () => ({ exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false });
    let scope!: NonNullable<ReturnType<typeof currentBatchScope>>;
    let closeStarted!: () => void;
    const closing = new Promise<void>((resolve) => (closeStarted = resolve));
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    const run = runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      scope = currentBatchScope()!;
      await helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE });
      const session = lock.sessions[0];
      const close = session.close.bind(session);
      session.close = async () => {
        closeStarted();
        await gate;
        return close();
      };
    });
    await closing;
    const late = scope.step({ volume: VOLUME, kind: 'listConfigs', params: { repository: 'acme/app' }, options: {} }, async () => ({ image: IMAGE.id!, socket: '/var/run/docker.sock' }));
    openGate();
    await run;
    const error = await refusal(late);
    expect(error.code).toBe('helperFailed');
    expect(lock.opens).toHaveLength(1);
    expect(lock.events).toEqual(['open s1', 'close s1']);
  });

  it('runs the steps of the scope one at a time', async () => {
    const { helper, lock } = setup();
    let running = 0;
    let most = 0;
    lock.stepResult = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { exitCode: 0, stdout: '["a"]\n', stderr: '', timedOut: false };
    };
    await runWithBatchScope(lock, VOLUME, silentLogger, async () => {
      await Promise.all([1, 2, 3].map(() => helper.listConfigurations({ volumeName: VOLUME, repository: 'acme/app', image: IMAGE })));
    });
    expect(most).toBe(1);
    expect(lock.opens).toHaveLength(1);
  });
});
