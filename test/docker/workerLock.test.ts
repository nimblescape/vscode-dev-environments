// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: the environment lock with the real workers (two windows, as two windows or computers, each with its
// own records) on the real Docker engine of the runner, with a state volume of the test. Checked: an operation of a second
// window is refused as busy while the first holds the lock; after a hard kill of the first worker, the kernel freed the
// lock and the second takes it; two Deletes of the same environment at the same time give exactly one winner, and the
// other removes nothing (user decision D3); no worker container is left over. Plan step 6, PR A: a Start and a Delete of
// the same environment at the same time, with the wait of the worker (10 s): exactly one wins, the other is refused as
// busy after the wait and changes nothing; a Delete while the question of a Start is open is refused as busy (the Start
// holds the lock during the question). Plan step 11I1, PR A2: the operations are the flows of the worker, as the window
// sends them (workerWindow.ts), instead of the pipeline of the test process over the `lock` relay of the worker (removed
// by 11I1); the lock is the worker's own, with its own wait (ENVIRONMENT_LOCK_WAIT_SECONDS; the relay took a shorter one
// of the test). The opens make sure of the real Session Monitor (decision D9 of 2026-10-07).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Plan step 11I2: the Docker CLI of the extension (BootstrapDocker) in place of the removed CLI adapter ContainerAdapter.
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { LABEL_ENVIRONMENT_ID, LABEL_REPOSITORY, newEnvironmentId, resourceName } from '../../src/core/names';
import { ENVIRONMENT_LOCK_WAIT_SECONDS, PipelineTexts } from '../../src/core/pipeline/operationBase';
import { isoTime, systemClock } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { FakeUi, RecordingProgress, TEST_ACCOUNT, dockerTestContext, testHelperImage } from './harness';
import { monitorOfUser, removeTestMonitor, seedTestMonitorRun, testComputer, workerWindow, type WorkerWindow } from './workerWindow';

const REPOSITORY = 'devenv-test/worker-lock';

describe('the environment lock with real workers (plan step 5, PR B)', () => {
  const context = dockerTestContext('workerLock');
  const { run, env, cli, log } = context;
  const runner = new NodeProcessRunner();
  const docker = new BootstrapDocker(runner, run.dockerPath, env, log);
  // Decision D9 of 2026-10-07: the opens make sure of the real Session Monitor; a monitor of the user is never touched.
  const skipped = monitorOfUser({ run });
  const windows: WorkerWindow[] = [];

  /**
   * A window of one computer (its own records), with the workers of the state volume of this file (the locks of all
   * windows of the file are the same lock files). Plan step 11I1, PR A2: was the service of the test process over the
   * `lock` relay of its workers.
   */
  function window(name: string, ui?: FakeUi): WorkerWindow {
    const opened = workerWindow(context, docker, { name: 'workerLock', computer: testComputer(context, `workerLock-${name}`), windowId: `docker-test-worker-lock-${name}`, ...(ui === undefined ? {} : { ui }) });
    windows.push(opened);
    return opened;
  }

  /** Both workers are opened first, so that the operations race for the lock and not for the open of a worker. */
  async function workersReady(...ready: WorkerWindow[]): Promise<void> {
    for (const one of ready) expect(await one.locks.channels.get(await one.targets.current())).toBeDefined();
  }

  /** The entry of an environment in the records of each window. */
  async function addEntry(environmentId: string, name: string, ...to: WorkerWindow[]): Promise<void> {
    const now = isoTime(systemClock);
    const entry = {
      id: environmentId,
      repository: REPOSITORY,
      configPath: '.devcontainer/devcontainer.json',
      volumeName: name,
      containerName: name,
      createdAt: now,
      lastUsedAt: now,
      owner: TEST_ACCOUNT,
      dockerHost: '',
    };
    for (const one of to) await one.registry.add({ ...entry });
  }

  const deleteIn = (one: WorkerWindow, environmentId: string) =>
    one.targets.withOperation(() => one.service.deleteInWorker(environmentId, { progress: new RecordingProgress(), additionalVolumesToRemove: [] }));

  beforeAll(async () => {
    if (skipped) {
      log.info('The engine has a Session Monitor before the tests; the lock tests through real workers are skipped.');
      return;
    }
    // Plan step 11I (U7, decision of 2026-10-08): the helper image through the harness (before: ensureImage of a
    // WorkspaceHelper).
    await testHelperImage(docker, log, env);
    // Review round 1 of 11H2 (A-L5): the real monitor of the opens runs no background run during the tests.
    await seedTestMonitorRun(docker, { run });
  });

  afterAll(async () => {
    // Review round 1 of PR #117 (A-H2): all windows close together (each waits for its batch helpers to be gone).
    const leftovers = [...new Set((await Promise.all(windows.map((one) => one.dispose()))).flat())];
    removeRunObjects(cli, run.runId);
    removeTestMonitor({ run, cli });
    expect(leftovers).toEqual([]);
  });

  // Plan step 11I1, PR A2: the first window holds the lock through an open whose question waits (Q3: the lock stays held
  // during a question), instead of the `lock` operation of the relay; the second is refused by its Delete after the wait
  // of the worker (was: the short wait of the test, 1 s); after the kill, the Delete of the second wins; the first window
  // then runs an operation under the lock with a new worker (was: it took the lock again).
  it.skipIf(skipped)('a second window is busy while the first holds the lock; after a hard kill of the first worker the second takes it', { timeout: 180_000 }, async () => {
    let asked!: () => void;
    const questionOpen = new Promise<void>((resolve) => (asked = resolve));
    class WaitingUi extends FakeUi {
      override async filesMissing(repository: string): Promise<'cloneAgain' | 'deleteEnvironment' | undefined> {
        await super.filesMissing(repository);
        asked();
        // Never answered: the worker of this window is killed while it waits.
        return new Promise(() => {});
      }
    }
    const first = window('first', new WaitingUi());
    const second = window('second');
    await workersReady(first, second);
    const environmentId = newEnvironmentId();
    const name = resourceName(REPOSITORY, environmentId);
    // No workspace volume: the open asks what to do (concept 7.12), and holds the lock while it waits.
    cli.ok(['run', '-d', '--stop-timeout', '1', '--name', name, '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`, '--label', `${TEST_RUN_LABEL}=${run.runId}`, TEST_BASE_IMAGE, 'sleep', '3600']);
    await addEntry(environmentId, name, first, second);
    const open = first.targets.withOperation(() => first.service.openEnvironmentInWorker(environmentId, { progress: new RecordingProgress() })).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    await Promise.race([
      questionOpen,
      open.then((error) => {
        throw new Error(`The open ended before its question: ${error?.message ?? 'it succeeded'}`);
      }),
    ]);

    const startedAt = Date.now();
    await expect(deleteIn(second, environmentId)).rejects.toMatchObject({ message: PipelineTexts.environmentLockBusy(REPOSITORY) });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(ENVIRONMENT_LOCK_WAIT_SECONDS * 1000 - 500);
    expect(cli.container(name)).toBeDefined();

    // A hard kill of the container of the first worker: nothing lets go of the lock but the kernel.
    expect(first.locks.workerNames).toHaveLength(1);
    cli.ok(['kill', '--signal', 'KILL', first.locks.workerNames[0]]);
    expect(await open).toBeInstanceOf(Error);
    await deleteIn(second, environmentId);
    expect(cli.container(name)).toBeUndefined();
    expect(await second.registry.get(environmentId)).toBeUndefined();
    // Released: the first window runs an operation under the lock again, with a new worker.
    await first.targets.withOperation(() => first.service.stop(environmentId));
    expect(first.locks.workerNames).toHaveLength(2);
  });

  it.skipIf(skipped)('two Deletes of the same environment at the same time: exactly one winner, the other removes nothing', { timeout: 180_000 }, async () => {
    const a = window('a');
    const b = window('b');
    await workersReady(a, b);
    const environmentId = newEnvironmentId();
    const name = resourceName(REPOSITORY, environmentId);
    cli.ok(['volume', 'create', '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`, '--label', `${LABEL_REPOSITORY}=${REPOSITORY}`, '--label', `${TEST_RUN_LABEL}=${run.runId}`, name]);
    // `sleep` as process 1 ignores SIGTERM. Plan step 11I1, PR A2: the stop of the winner takes longer than the wait of
    // the worker (was 5 s, longer than the 1 s wait of the test), while it holds the lock.
    cli.ok([
      'run', '-d', '--stop-timeout', String(ENVIRONMENT_LOCK_WAIT_SECONDS + 5), '--name', name,
      '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`, '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      '--mount', `type=volume,source=${name},target=/workspaces`,
      TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
    await addEntry(environmentId, name, a, b);

    const outcomes = await Promise.allSettled([a, b].map((one) => deleteIn(one, environmentId)));
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0].reason as Error).message).toBe(PipelineTexts.environmentLockBusy(REPOSITORY));
    // The winner removed everything; the entry of the other stays, without its busy mark.
    expect(cli.container(name)).toBeUndefined();
    expect(cli.volume(name)).toBeUndefined();
    const winner = outcomes[0].status === 'fulfilled' ? a : b;
    const loser = winner === a ? b : a;
    expect(await winner.registry.get(environmentId)).toBeUndefined();
    const kept = await loser.registry.get(environmentId);
    expect(kept?.id).toBe(environmentId);
    expect(kept?.busy).toBeUndefined();
  });

  // Plan step 6, PR A (user decision D2): Start takes the lock too. The Start finds the volume missing and asks; the
  // answer "Delete environment" deletes it under the lock that the Start holds. The Delete of the other window stops and
  // removes the same container. Either holds the lock for the stop time of the container (15 s, longer than the wait), so
  // the other one is refused as busy after the 10 s wait (D3) and changes nothing.
  it.skipIf(skipped)('a Start and a Delete of the same environment at the same time: exactly one winner, the other is refused as busy after 10 s', { timeout: 180_000 }, async () => {
    class DeletingUi extends FakeUi {
      override async filesMissing(repository: string): Promise<'cloneAgain' | 'deleteEnvironment' | undefined> {
        await super.filesMissing(repository);
        return 'deleteEnvironment';
      }
    }
    const starter = window('start', new DeletingUi());
    const deleter = window('delete');
    await workersReady(starter, deleter);
    const environmentId = newEnvironmentId();
    const name = resourceName(REPOSITORY, environmentId);
    // No workspace volume: the Start asks what to do (concept 7.12) and gets "Delete environment".
    cli.ok([
      'run', '-d', '--stop-timeout', '15', '--name', name,
      '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`, '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
    await addEntry(environmentId, name, starter, deleter);

    const startedAt = Date.now();
    const settledAfter: number[] = [];
    const outcomes = await Promise.allSettled(
      [
        (): Promise<unknown> => starter.targets.withOperation(() => starter.service.openEnvironmentInWorker(environmentId, { progress: new RecordingProgress() })),
        (): Promise<unknown> => deleteIn(deleter, environmentId),
      ].map((operation, index) =>
        operation().finally(() => {
          settledAfter[index] = Date.now() - startedAt;
        }),
      ),
    );
    const busy = PipelineTexts.environmentLockBusy(REPOSITORY);
    const refused = outcomes.map((outcome) => outcome.status === 'rejected' && (outcome.reason as Error).message === busy);
    // Exactly one is refused as busy: the Start (the Delete won) or the Delete (the Start won and deleted).
    expect(refused.filter(Boolean)).toHaveLength(1);
    const loserIndex = refused.indexOf(true);
    const winnerIndex = 1 - loserIndex;
    if (winnerIndex === 0) {
      // The Start won: its question was answered with "Delete environment", which ends the open as cancelled.
      expect(outcomes[0].status).toBe('rejected');
      expect(((outcomes[0] as PromiseRejectedResult).reason as Error).message).toBe('The operation was cancelled.');
    } else {
      expect(outcomes[1].status).toBe('fulfilled');
    }
    // The loser waited for the lock (D3: 10 s) before it was refused.
    expect(settledAfter[loserIndex]).toBeGreaterThanOrEqual(ENVIRONMENT_LOCK_WAIT_SECONDS * 1000 - 500);
    // The winner removed the container and its entry; the loser's entry stays, without a busy mark or pending file.
    expect(cli.container(name)).toBeUndefined();
    const [winner, loser] = winnerIndex === 0 ? [starter, deleter] : [deleter, starter];
    expect(await winner.registry.get(environmentId)).toBeUndefined();
    const kept = await loser.registry.get(environmentId);
    expect(kept?.id).toBe(environmentId);
    expect(kept?.busy).toBeUndefined();
    expect((await loser.sessionFiles.readPendings()).map((pending) => pending.environmentId)).toEqual([]);
  });

  // Plan step 6, PR A (user decisions D2 and Q3 of 2026-10-01): the Start holds the lock while its question to the user
  // is open. A Delete of another window that comes during the question is refused as busy after the wait (D3) and
  // removes nothing; then the answer "Delete environment" deletes it under the Start's lock. Without the lock of the
  // Start, the Delete would win at once.
  it.skipIf(skipped)('a Delete while the question of a Start is open is refused as busy after 10 s; the Start goes on under its lock', { timeout: 180_000 }, async () => {
    let asked!: () => void;
    const questionOpen = new Promise<void>((resolve) => (asked = resolve));
    let deleteEnded!: () => void;
    const deleteSettled = new Promise<void>((resolve) => (deleteEnded = resolve));
    class WaitingUi extends FakeUi {
      override async filesMissing(repository: string): Promise<'cloneAgain' | 'deleteEnvironment' | undefined> {
        await super.filesMissing(repository);
        asked();
        // The answer comes after the Delete of the other window has ended (refused, or done without the Start's lock).
        await deleteSettled;
        return 'deleteEnvironment';
      }
    }
    const starter = window('start-question', new WaitingUi());
    const deleter = window('delete-question');
    await workersReady(starter, deleter);
    const environmentId = newEnvironmentId();
    const name = resourceName(REPOSITORY, environmentId);
    cli.ok([
      'run', '-d', '--stop-timeout', '1', '--name', name,
      '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`, '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
    await addEntry(environmentId, name, starter, deleter);

    const start = starter.targets.withOperation(() => starter.service.openEnvironmentInWorker(environmentId, { progress: new RecordingProgress() })).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    // A Start that ends before its question fails the test at once (instead of at the time limit of the test).
    await Promise.race([
      questionOpen,
      start.then((error) => {
        throw new Error(`The Start ended before its question: ${error?.message ?? 'it succeeded'}`);
      }),
    ]);
    const deleteStartedAt = Date.now();
    const deleting = deleteIn(deleter, environmentId).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    void deleting.finally(() => deleteEnded());
    const deleteError = await deleting;
    const deleteTook = Date.now() - deleteStartedAt;
    expect(deleteError?.message).toBe(PipelineTexts.environmentLockBusy(REPOSITORY));
    expect(deleteTook).toBeGreaterThanOrEqual(ENVIRONMENT_LOCK_WAIT_SECONDS * 1000 - 500);
    // The refused Delete removed nothing and left no busy mark.
    expect(cli.container(name)).toBeDefined();
    expect((await deleter.registry.get(environmentId))?.busy).toBeUndefined();
    // The Start's answer "Delete environment" deletes it under the Start's lock, and the open ends as cancelled.
    expect((await start)?.message).toBe('The operation was cancelled.');
    expect(cli.container(name)).toBeUndefined();
    expect(await starter.registry.get(environmentId)).toBeUndefined();
    expect((await deleter.registry.get(environmentId))?.id).toBe(environmentId);
  });
});
