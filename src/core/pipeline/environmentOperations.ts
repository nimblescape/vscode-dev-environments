// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F1 (decision 1 of 2026-10-03: no bypass of the worker, by construction): the operations of a window. Each
// sends its flow to the worker of the Docker target (EnvironmentServiceDeps.flow before): the open (plan step 11E6),
// Stop, Delete and its check, the listing of Select configuration, the reads of an attached window, the refresh and the
// rebuild of the registry; the worker runs the pipeline (EnvironmentService). Nothing of the pipeline is imported here,
// so the extension's bundle holds none of it. No `vscode`.
import { registryBusyMarks, type EnvironmentBusyMarks } from './busyMarks';
import { type DeleteDecision } from './deleteCheck';
import { waitingTimeMs } from '../busy';
import { environmentsOfHost } from '../docker/dockerHost';
import { UserFacingError, errorMessage } from '../errors';
import {
  LOCK_BUSY_CODE,
  LOCK_UNAVAILABLE_CODE,
  OP_DELETE,
  OP_DELETE_CHECK,
  OP_LIST_CONFIGURATIONS,
  OP_OPEN,
  OPEN_PROGRESS_DETAIL,
  OP_RECONCILE,
  OP_STOP,
  OP_WINDOW_STATE,
  parseDeleteCheckParams,
  parseDeleteCheckValue,
  parseDeleteParams,
  parseDeleteValue,
  parseListConfigurationsParams,
  parseReconcileParams,
  parseReconcileValue,
  parseListConfigurationsValue,
  parseOpenParams,
  parseOpenValue,
  parseStopParams,
  parseStopValue,
  parseWindowStateParams,
  parseWindowStateValue,
  type OpenParams,
  type WindowStateValue,
} from '../helperChannel/protocol';
import type { ImageSettings } from '../remoteMonitor/protocol';
import { HelperChannelError, HelperOperationError } from '../helperChannel/helperChannel';
import { Steps, type ProgressStep } from '../messages';
import { repositoryFolder, splitRepository } from '../names';
import { isAvailableTo } from '../ownership';
import { type EnvironmentRuntimeState, type EnvironmentStates, type StateEnvironment } from './refreshStates';
import { hostAccessChecks } from '../policy/hostAccessChecks';
import { isoTime } from '../ports';
import type { Environment, GitHubAccount } from '../types';
import { LIFECYCLE_UNKNOWN } from './lifecycleMemory';
import { registryOpenRecords, type OpenRecords } from './openRecords';

import {
  OperationBase,
  StepReporter,
  cancelledError,
  environmentMissing,
  repositoryKey,
  refusalError,
  PipelineTexts,
  ENVIRONMENT_LOCK_WAIT_SECONDS,
  STOP_FLOW_TIMEOUT_MS,
  WINDOW_STATE_FLOW_TIMEOUT_MS,
  LIST_CONFIGURATIONS_FLOW_TIMEOUT_MS,
  DELETE_FLOW_TIMEOUT_MS,
  DELETE_CHECK_FLOW_TIMEOUT_MS,
  RECONCILE_FLOW_TIMEOUT_MS,
  OPEN_FLOW_TIMEOUT_MS,
  type DockerStarter,
  type OpenOptions,
  type OpenResult,
  type OperationBaseDeps,
  type OperationOptions,
  type RepositoryTarget,
  type WindowEnvironmentStore,
} from './operationBase';

/** Plan step 11E6: the longest detail of a step of the open that the worker reports (the progress notification). */
const MAX_OPEN_DETAIL_LENGTH = 1000;

/**
 * Plan step 11B2 (decision of 2026-10-03, the worker is the deputy): runs a flow in the worker of the Docker target of the
 * operation; the worker takes the lock of the environment itself. Rejects with a HelperChannelError when there is no
 * worker, and with a HelperOperationError (`busy` for a lock held elsewhere) when the flow fails. Plan step 11C1, review
 * round 1 (A-R1-1): `passive`, a read in the background.
 */
export type OperationFlow = (
  op: string,
  params: unknown,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    passive?: boolean;
    // Review round 1 of 11C2b (A-R1-M1): each answer of the user to a question of the flow.
    onAnswer?: (call: string, args: unknown[], value: unknown) => void;
    // Review round 3 of 11C2b (A-R3-L1): a question of the flow is asked, and has its answer (or failed).
    onQuestion?: (state: 'asked' | 'settled') => void;
    // Plan step 11E6: a step of the flow began (the progress of the open).
    onProgress?: (step: string, detail?: string) => void;
  },
) => Promise<unknown>;

/** The deps of the operations of a window. */
export interface EnvironmentOperationsDeps extends OperationBaseDeps {
  /** The registry of this computer (plan step 11I, PR D: the window's operations also change its entries). */
  registry: WindowEnvironmentStore;
  /** Plan step 11C2a: the busy marks of the window. Default: over `registry` (registryBusyMarks). */
  busyMarks?: EnvironmentBusyMarks;
  /** Plan step 11E4a: the registry writes of the open. Default: over `registry` (registryOpenRecords). */
  openRecords?: OpenRecords;
  /** Starts Docker when it does not run (concept 7.6 "Docker start"; for a remote host only a check). */
  startDocker: DockerStarter;
  /** Whether the Docker engine of the operation answers (Stop does nothing without it). */
  dockerRunning: () => Promise<boolean>;
  /**
   * Plan step 5, PR C; plan step 11C1: readEnvironmentStates in the worker of the Docker target (HelperChannels.refresh);
   * it makes the worker ready first, and rejects when it cannot.
   */
  workerRefresh: (environments: readonly StateEnvironment[]) => Promise<EnvironmentStates>;
  /** Plan step 11B2: runs a flow in the worker of the Docker target of the operation (see EnvironmentServiceDeps before 11F1). */
  flow: OperationFlow;
  /** Plan step 11C2a: the id of this computer in the Session Monitor (Delete's `forget`, the open's first heartbeat). */
  monitorSource?: () => string;
  /** Plan step 11E6 (decision D1 of 2026-10-05): the image maintenance and the image list of an open. */
  openMonitor?: (dockerHost: string) => { images: ImageSettings; repositories?: string[]; listSent: () => void };
}

/** Plan step 11F1: the operations of a window, sent to the worker (see the module comment). */
export class EnvironmentOperations extends OperationBase {
  constructor(protected override readonly deps: EnvironmentOperationsDeps) {
    super(deps, deps.startDocker, (view) => ({
      busyMarks: deps.busyMarks ?? registryBusyMarks(deps.registry, view),
      openRecords: deps.openRecords ?? registryOpenRecords(deps.registry, view),
    }));
  }

  /**
   * Plan step 11E6 (decisions of 2026-10-03 and 2026-10-04): the open of a repository (`open`) by the worker of the Docker
   * target, as the operation `open` (openThroughWorker). The worker's pipeline finds the environment of the repository of
   * the signed-in account, or creates it.
   */
  async openInWorker(target: RepositoryTarget, options: OpenOptions): Promise<OpenResult> {
    splitRepository(target.repository);
    return this.exclusive(repositoryKey(target.repository), options.signal, async () => {
      try {
        return await this.openThroughWorker(
          target.repository,
          { target: { ...(target.defaultBranch !== undefined ? { defaultBranch: target.defaultBranch } : {}), configPaths: [...target.configPaths], trusted: target.trusted } },
          options,
        );
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  /** Plan step 11E6: the open of an existing environment (`openEnvironment`) by the worker of the Docker target (openThroughWorker). */
  async openEnvironmentInWorker(environmentId: string, options: OpenOptions): Promise<OpenResult> {
    const environment = await this.deps.registry.get(environmentId);
    if (!environment) throw environmentMissing();
    await this.requireCurrentHost(environment);
    return this.exclusive(repositoryKey(environment.repository), options.signal, async () => {
      try {
        const current = await this.deps.registry.get(environmentId);
        if (!current) throw environmentMissing(environment.repository);
        return await this.openThroughWorker(current.repository, { environmentId: current.id }, options);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  /**
   * Plan step 11E6 (decision A1 of 2026-10-05): sends the open to the worker and answers with what the window needs to
   * connect, after the worker released the lock of the environment. Before it is sent: the sign-in of this window (with a
   * dialog when needed: the worker asks for the token without one) and the start of the local Docker (concept 7.6). The
   * steps of the worker are the progress of the open. Decision D1: the open carries the image maintenance of this
   * computer and the image list. The answer names an environment of the signed-in account on the Docker host of the
   * operation (and of the repository of the open), which the window takes from its own registry.
   */
  private async openThroughWorker(
    repository: string,
    what: Pick<OpenParams, 'environmentId'> | Pick<OpenParams, 'target'>,
    options: OpenOptions,
  ): Promise<OpenResult> {
    const { signal } = options;
    const session = await this.requireSession();
    // Review round 1 of PR #111 (A-L1): an environment of another account is never sent (concept 7.5, as before the move).
    if ('environmentId' in what && what.environmentId !== undefined) {
      const entry = await this.deps.registry.get(what.environmentId);
      if (!entry) throw environmentMissing(repository);
      this.availableEntry(entry, session.account);
    }
    await this.startDocker(new StepReporter(options.progress, this.logger), signal);
    this.throwIfCancelled(signal);
    const dockerHost = await this.currentDockerHost();
    const monitor = this.deps.openMonitor?.(dockerHost);
    const settings = this.deps.settings();
    const params = parseOpenParams({
      dockerHost,
      owner: this.deps.owner,
      monitorSource: this.deps.monitorSource?.(),
      settings: {
        updateImagesOnConnect: settings.updateImagesOnConnect,
        hostAccessChecks: hostAccessChecks(repository, settings),
        waitingTimeSeconds: waitingTimeMs(settings) / 1000,
        stopOnClose: settings.stopOnClose !== false,
        respectShutdownActionNone: settings.respectShutdownActionNone === true,
        ...(settings.stopAfterMinutes !== undefined ? { stopAfterMinutes: settings.stopAfterMinutes } : {}),
      },
      images: monitor?.images,
      ...(monitor?.repositories !== undefined ? { repositories: monitor.repositories } : {}),
      repository,
      ...what,
      ...(options.forceRebuild === true ? { forceRebuild: true } : {}),
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    });
    if (params === undefined) throw new Error(`The open of ${repository} cannot be sent to the worker.`);
    // The steps of the worker's pipeline (it logs them itself); `starting`: its `up` may run from here on.
    let started = false;
    const onProgress = (step: string, detail?: string) => {
      if (step === OPEN_PROGRESS_DETAIL) {
        const text = detail ?? '';
        options.progress.detail(text.length > MAX_OPEN_DETAIL_LENGTH ? `${text.slice(0, MAX_OPEN_DETAIL_LENGTH - 1)}…` : text);
      } else if (Object.hasOwn(Steps, step)) {
        if (step === 'starting') started = true;
        options.progress.step(step as ProgressStep);
      }
    };
    let answer: unknown;
    try {
      answer = await this.workerFlow({ repository }, OP_OPEN, params, OPEN_FLOW_TIMEOUT_MS, signal, undefined, undefined, onProgress);
    } catch (error) {
      // Review round 1 of PR #111 (A-M1): the user cancelled a question of the open in the worker (the worker cleaned up
      // through its requests, which were answered): a cancel, as before the move.
      // Review round 2 of PR #111 (A2-M1): never a worker that ended the operation itself (its shutdown, a defect): its
      // requests ended with it, so this window cleans up.
      if (error instanceof HelperOperationError && error.code === 'cancelled' && !error.timedOut && !error.aborted && signal?.aborted !== true) throw cancelledError();
      await this.afterLostWorkerOpen(repository, params, session.account, started);
      throw error;
    }
    const value = parseOpenValue(answer);
    if (value === undefined) {
      await this.afterLostWorkerOpen(repository, params, session.account, started);
      throw new Error(`The worker answered the open of ${repository} with an invalid value.`);
    }
    if (value.imageListSent === true) monitor?.listSent();
    if ('refused' in value) throw refusalError(value.refused);
    const { opened } = value;
    const environment = await this.deps.registry.get(opened.environmentId);
    const expected = params.environmentId ?? (await this.deps.registry.findForAccount(repository, session.account.id, dockerHost))?.id;
    // Review round 1 of PR #111 (A-I1): and its folder is the one that the open recorded (`record openFinished`).
    if (
      !environment ||
      environment.id !== expected ||
      !isAvailableTo(environment, session.account) ||
      (environment.dockerHost ?? '') !== dockerHost ||
      environment.remoteWorkspaceFolder !== opened.remoteWorkspaceFolder
    ) {
      throw new Error(`The worker answered the open of ${repository} with an environment that is not the one of the open.`);
    }
    return { environment, containerName: opened.containerName, remoteWorkspaceFolder: opened.remoteWorkspaceFolder };
  }

  /**
   * Plan step 11E6: a worker open that ended without its answer (a lost channel, its time limit, a cancel) could not
   * clean up on this computer: its requests end with it. This window does it for the environment of the open (as the
   * pipeline's own `finally` blocks did): the pending connection file goes; the busy mark of this window goes, and a
   * create mark stays as ended (so the next open completes the clone, or Delete removes the environment: PR #78, A-R1-1);
   * and when the worker had begun `up` (its step `starting`), this window remembers the lifecycle of the environment as
   * unknown (review round 1 of PR #107, A-L2: the worker could record neither the lifecycle mark nor this window's
   * memory), so its next open of the environment does not open a running container as it is (LIFECYCLE_UNKNOWN).
   */
  private async afterLostWorkerOpen(repository: string, params: OpenParams, account: GitHubAccount, started: boolean): Promise<void> {
    const id =
      params.environmentId ??
      (await this.deps.registry.findForAccount(repository, account.id, params.dockerHost).catch((error: unknown) => {
        this.logger.warn(`The environment of ${repository} could not be read after the open in the worker ended: ${errorMessage(error)}`);
        return undefined;
      }))?.id;
    if (id === undefined) return;
    await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(id));
    await this.quietly('end the busy mark of this window', async () => {
      const busy = (await this.deps.registry.get(id))?.busy;
      if (busy === undefined || busy.windowId !== this.deps.owner.windowId || busy.pid !== this.deps.owner.pid) return;
      if (busy.operation === 'create') await this.openRecords.createMark(id, 'ended');
      else await this.busyMarks.clear(id);
    });
    if (started) {
      await this.lifecycleMemory.remember(id, LIFECYCLE_UNKNOWN).catch((error: unknown) => this.logger.warn(`The window could not remember ${repository}: ${errorMessage(error)}`));
      this.logger.warn(`The open of ${repository} in the worker ended while it started the container: the next open of this window runs its lifecycle commands again.`);
    }
  }

  /**
   * Stop: records the Git summary from the running container, then `docker stop`. Does not start Docker. The other
   * services of a Docker Compose environment are stopped after the dev container (D-20).
   */
  async stop(environmentId: string): Promise<void> {
    const environment = await this.deps.registry.get(environmentId);
    if (!environment) {
      this.logger.info(`Stop: the environment ${environmentId} does not exist.`);
      return;
    }
    await this.requireCurrentHost(environment);
    await this.requireOwnAccount(environment, false);
    await this.exclusive(repositoryKey(environment.repository), undefined, async () => {
      // Unit 7, PR 2: Stop ends Close and Keep Running (Keep Running When Closed stays).
      if ((await this.deps.registry.get(environmentId))?.keepRunningOnce !== undefined) {
        await this.quietly('clear Close and Keep Running', () =>
          this.deps.registry.updateEnvironment(environmentId, (entry) => {
            delete entry.keepRunningOnce;
          }),
        );
      }
      if (!(await this.deps.dockerRunning())) {
        this.logger.info('Docker is not running, so no container runs.');
        return;
      }
      // An update, rebuild, or delete in another window replaces or removes the container: no stop in between (concept
      // 7.9 rule 1 applies to the Session Monitor; a Stop from a sidebar that is not up to date must respect it too).
      const env = await this.waitForOtherOperation((await this.deps.registry.get(environmentId)) ?? environment, undefined);
      // Plan step 11B2: the Stop runs in the worker, under the lock of the environment that the worker takes itself (user
      // decisions D1 to D3); this window records the Git state that it answers.
      // Review round 1 (A-R1-5): the parameters are checked here, so that one the worker would refuse is named.
      const params = parseStopParams({
        environmentId: env.id,
        containerName: env.containerName,
        folder: repositoryFolder(env.repository),
        ...(env.remoteUser !== undefined && env.remoteUser !== '' ? { user: env.remoteUser } : {}),
        waitSeconds: ENVIRONMENT_LOCK_WAIT_SECONDS,
      });
      if (params === undefined) {
        throw new UserFacingError('recordInvalid', PipelineTexts.stopRefused(env.repository), `container ${env.containerName}, remote user ${JSON.stringify(env.remoteUser ?? '')}, repository ${env.repository}`);
      }
      const value = parseStopValue(await this.workerFlow(env, OP_STOP, params, STOP_FLOW_TIMEOUT_MS));
      if (value === undefined) throw new Error(`The worker answered the Stop of ${env.repository} with an invalid value.`);
      const summary = value.gitSummary;
      if (summary !== undefined) {
        // Review round 1 (A-R1-1): the time of this computer, as the other times of the entry (lastUsedAt), never the
        // clock of the Docker host; recordedStateNote compares them.
        const recorded = { ...summary, recordedAt: isoTime(this.deps.clock) };
        await this.quietly('record the Git state', () =>
          this.deps.registry.updateEnvironment(env.id, (entry) => {
            entry.gitSummary = recorded;
          }),
        );
      }
      // Review round 1 (A-R1-2): the containers that could not be stopped, after the Git state is recorded.
      if (value.failures.length > 0) throw new Error(value.failures.join(' '));
    });
  }

  /**
   * Plan step 11B2: a flow in the worker, with the refusals of the lock as before the move (user decisions D1 to D3): a
   * lock held elsewhere is environmentLockBusy, no worker (or no helper image for it) is environmentLockUnavailable, and
   * nothing runs another way. Any other failure of the flow is thrown as it is.
   */
  private async workerFlow(
    env: Pick<Environment, 'repository'>,
    op: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    onAnswer?: (call: string, args: unknown[], value: unknown) => void,
    onQuestion?: (state: 'asked' | 'settled') => void,
    // Plan step 11E6: the progress of the flow (the open).
    onProgress?: (step: string, detail?: string) => void,
  ): Promise<unknown> {
    try {
      return await this.deps.flow(op, params, { signal, timeoutMs, ...(onAnswer ? { onAnswer } : {}), ...(onQuestion ? { onQuestion } : {}), ...(onProgress ? { onProgress } : {}) });
    } catch (error) {
      if (this.isCancellation(error, signal)) throw error;
      if (error instanceof HelperOperationError && error.code === LOCK_BUSY_CODE) {
        this.logger.info(`${env.repository} is locked on the Docker host by another window or computer: ${error.message}`);
        throw new UserFacingError('startFailed', PipelineTexts.environmentLockBusy(env.repository), error.message);
      }
      // Review round 1 (A-R1-3): only a refusal before anything ran is "nothing is changed": the lock that could not be
      // taken, or a worker that could not be reached or knows no such flow (review round 2, A-R2-1: `closed` is not sent). A channel lost while the flow ran is thrown as
      // it is (the flow may have changed something).
      if ((error instanceof HelperOperationError && error.code === LOCK_UNAVAILABLE_CODE) || (error instanceof HelperChannelError && (error.code === 'unavailable' || error.code === 'unsendable' || error.code === 'open' || error.code === 'closed'))) {
        this.logger.warn(`${env.repository}: the worker on the Docker host could not be reached, so nothing is changed: ${errorMessage(error)}`);
        throw new UserFacingError('helperFailed', PipelineTexts.environmentLockUnavailable(env.repository, errorMessage(error)), errorMessage(error));
      }
      throw error;
    }
  }

  /**
   * Plan step 11C2b (decisions of 2026-10-03 and 2026-10-04): the check of Delete and its questions in the worker of the
   * Docker host of the operation (`deleteCheck`), which asks them through its requests. A refusal of its pipeline is
   * thrown as before the move; a worker that cannot be reached is refused as for Stop (workerFlow). An environment that
   * is not in the registry is not deleted (cancel); nothing is sent then.
   */
  async deleteCheckInWorker(environmentId: string, options: OperationOptions & { repository: string; otherWindow: boolean }): Promise<DeleteDecision> {
    const environment = await this.deps.registry.get(environmentId);
    if (!environment) {
      this.logger.info(`The environment ${environmentId} does not exist anymore. Nothing is deleted.`);
      return { decision: 'cancel' };
    }
    await this.requireCurrentHost(environment);
    try {
      const params = parseDeleteCheckParams({
        environmentId: environment.id,
        dockerHost: await this.currentDockerHost(),
        owner: this.deps.owner,
        repository: options.repository,
        otherWindow: options.otherWindow,
      });
      if (params === undefined) throw new Error(`The check of the Delete of ${environment.repository} cannot be sent to the worker.`);
      // Review round 1 of 11C2b (A-R1-M1): the decision of the worker counts only as far as the user gave it here.
      const given = { confirm: undefined as unknown, volumes: [] as string[], volumesAnswer: undefined as unknown, serviceData: [] as string[], picked: [] as string[], cancelled: false };
      const onAnswer = (call: string, args: unknown[], value: unknown) => {
        if (call === 'confirmDelete') given.confirm = value;
        if (call === 'deleteAdditionalVolumes') {
          given.volumes = Array.isArray(args[0]) ? (args[0] as string[]) : [];
          given.volumesAnswer = value;
          // Review round 2 of 11C2b (A-R2-M1): Escape at a later question cancels the Delete.
          if (value !== 'remove' && value !== 'keep') given.cancelled = true;
        }
        if (call === 'deleteServiceData') {
          given.serviceData = Array.isArray(args[0]) ? (args[0] as string[]) : [];
          given.picked = Array.isArray(value) ? (value as string[]) : [];
          if (!Array.isArray(value)) given.cancelled = true;
        }
      };
      // Review round 3 of 11C2b (A-R3-L1): a decision while a question is still open is not the user's.
      let open = 0;
      const onQuestion = (state: 'asked' | 'settled') => {
        open += state === 'asked' ? 1 : -1;
      };
      const value = parseDeleteCheckValue(await this.workerFlow(environment, OP_DELETE_CHECK, params, DELETE_CHECK_FLOW_TIMEOUT_MS, options.signal, onAnswer, onQuestion));
      if (value === undefined) throw new Error(`The worker answered the check of the Delete of ${environment.repository} with an invalid value.`);
      if ('refused' in value) throw refusalError(value.refused);
      if (value.decision === 'cancel') return value;
      if (value.decision !== given.confirm || (value.decision === 'delete' && given.cancelled) || open > 0) {
        throw new Error(`The worker answered the check of the Delete of ${environment.repository} with a decision that the user did not give.`);
      }
      if (value.decision === 'delete') {
        const allowed = new Set([...(given.volumesAnswer === 'remove' ? given.volumes : []), ...given.picked.filter((name) => given.serviceData.includes(name))]);
        const odd = value.additionalVolumesToRemove.filter((name) => !allowed.has(name));
        if (odd.length > 0) throw new Error(`The worker answered the check of the Delete of ${environment.repository} with volumes that the user did not choose: ${odd.join(', ')}.`);
      }
      return value;
    } catch (error) {
      throw this.toUserError(error, options.signal);
    }
  }

  /**
   * Plan step 11C2a (decisions of 2026-10-03 and 2026-10-04): Delete (concept 7.14 steps 3 to 5) in the worker of the
   * Docker host of the operation, where its own pipeline runs `delete` (the busy mark, the entry and the session files of
   * the environment through its requests, the lock there, `forget` in the Session Monitor). The caller made the safety
   * check and closed a connected window. An environment that is not in the registry has nothing on Docker: only its
   * session files are removed here. A refusal of that pipeline is thrown as it was before the move; a worker that cannot
   * be reached or take the lock is refused as for Stop (workerFlow).
   */
  async deleteInWorker(environmentId: string, options: OperationOptions & { additionalVolumesToRemove: readonly string[] }): Promise<void> {
    const environment = await this.deps.registry.get(environmentId);
    if (!environment) {
      await this.removeEnvironmentFiles(environmentId);
      return;
    }
    await this.requireCurrentHost(environment);
    await this.exclusive(repositoryKey(environment.repository), options.signal, async () => {
      try {
        const monitorSource = this.deps.monitorSource?.();
        const params = parseDeleteParams({
          environmentId: environment.id,
          dockerHost: await this.currentDockerHost(),
          owner: this.deps.owner,
          additionalVolumesToRemove: [...options.additionalVolumesToRemove],
          monitorSource,
        });
        if (params === undefined) throw new Error(`The Delete of ${environment.repository} cannot be sent to the worker.`);
        let answer: unknown;
        try {
          answer = await this.workerFlow(environment, OP_DELETE, params, DELETE_FLOW_TIMEOUT_MS, options.signal);
        } catch (error) {
          // Review round 1 of 11C2a (A-R1-M1): a worker that ended without an answer (its channel lost, its time limit, a
          // cancel) may have marked the environment busy for this window and could not clear it; this window clears its
          // own mark (never the mark of another window). A refusal (the value) was cleared by the worker.
          await this.clearOwnMark(environment.id);
          throw error;
        }
        const value = parseDeleteValue(answer);
        if (value === undefined) throw new Error(`The worker answered the Delete of ${environment.repository} with an invalid value.`);
        if ('refused' in value) throw refusalError(value.refused);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  /**
   * Plan step 11B3b (user decision of 2026-10-04): the listing of Select configuration in the worker of the Docker host of
   * the operation, where its own pipeline runs listConfigurations (the record and the account through its requests, the
   * lock and the batch helper there). A refusal of that pipeline is thrown here as it was before the move; a worker that
   * cannot be reached or take the lock is refused as for Stop (workerFlow).
   */
  async listConfigurationsInWorker(environmentId: string, options: OperationOptions): Promise<string[]> {
    const env = await this.deps.registry.get(environmentId);
    if (!env) return [];
    try {
      const params = parseListConfigurationsParams({ environmentId: env.id, dockerHost: await this.currentDockerHost(), owner: this.deps.owner });
      if (params === undefined) throw new Error(`The listing of the configurations of ${env.repository} cannot be sent to the worker.`);
      const value = parseListConfigurationsValue(await this.workerFlow(env, OP_LIST_CONFIGURATIONS, params, LIST_CONFIGURATIONS_FLOW_TIMEOUT_MS, options.signal));
      if (value === undefined) throw new Error(`The worker answered the listing of the configurations of ${env.repository} with an invalid value.`);
      if ('refused' in value) throw refusalError(value.refused);
      return value.configPaths;
    } catch (error) {
      throw this.toUserError(error, options.signal);
    }
  }

  /**
   * Container and volume state of each environment. Does not start Docker: `undefined` when Docker does not run. Review
   * D2: no Docker call at all on an endpoint that is neither local nor SSH; its (empty) map of states. Plan step 5, PR C:
   * refreshStates without branches.
   */
  async inspectStates(): Promise<Map<string, EnvironmentRuntimeState> | undefined> {
    return (await this.refreshStates(new Set())).runtime;
  }

  /**
   * Plan step 5, PR C: the states of inspectStates and the branches of the running dev containers of `branchIds` (the
   * sidebar: the environments of the account), in one worker operation (`refresh`; plan step 11C1: also outside of an
   * operation, never directly). Plan step 5, PR D (rule D1 of 2026-09-30): a worker refresh that cannot be made or fails is
   * never read directly: the refresh fails (logged, with the cause). `runtime` is `undefined` when Docker does not run or
   * the states could not be read; then there are no branches.
   */
  async refreshStates(
    branchIds: ReadonlySet<string>,
  ): Promise<{ runtime: Map<string, EnvironmentRuntimeState> | undefined; branches: Map<string, string> }> {
    try {
      const readable = await this.readableDockerHost();
      if (readable === undefined) return { runtime: new Map(), branches: new Map() };
      if (!(await this.deps.dockerRunning())) return { runtime: undefined, branches: new Map() };
      // Unit 7: only the environments of the current Docker host; the others are hidden.
      const environments: StateEnvironment[] = environmentsOfHost(await this.deps.registry.list(), readable).map((env) => ({
        id: env.id,
        containerName: env.containerName,
        volumeName: env.volumeName,
        ...(env.remoteUser ? { user: env.remoteUser } : {}),
        folder: repositoryFolder(env.repository),
        branch: branchIds.has(env.id),
      }));
      // Plan step 5, PR D (rule D1 of 2026-09-30): a failure of the worker refresh fails the refresh (below). Plan step
      // 11C1: only through the worker.
      return await this.deps.workerRefresh(environments);
    } catch (error) {
      this.logger.warn(`The state of the environments could not be read: ${errorMessage(error)}`);
      return { runtime: undefined, branches: new Map() };
    }
  }

  /**
   * Plan step 11C1 (decisions of 2026-10-03 and 2026-10-04): what an attached window reads of the dev container
   * `containerName` of `environment`, by the worker of the Docker host of the operation (`windowState`): its state,
   * whether it may be used as it is, and with `branch` the branch of its repository. `undefined` when it could not be read
   * (the worker could not be reached, or it failed): the window keeps its state then (decision of 2026-10-04, "unknown").
   * Never throws. Review rounds 1 and 2 of 11C1 (A-R1-1, A-R2-M1, A-R2-M2): the worker is made ready passively (as for
   * the refresh: never a build of the helper image, the wait after a failed open kept), and within
   * WINDOW_STATE_FLOW_TIMEOUT_MS. Review round 3 (A-R3-M1): with `signal` (a read within an operation of the user, with
   * its progress and Cancel), it is made ready in full, as for the pipeline, until `signal` aborts.
   */
  async windowStateInWorker(
    environment: Environment,
    containerName: string,
    options: { branch?: boolean; signal?: AbortSignal } = {},
  ): Promise<WindowStateValue | undefined> {
    try {
      // Unit 7: an environment of another Docker host is not read through the worker of this one.
      if (!(await this.isOnCurrentHost(environment))) {
        // Review round 2 of PR #113 (A2-L2): the reason of an unread state is in the log.
        this.logger.info(`The state of the container ${containerName} was not read: Docker is set to another host now.`);
        return undefined;
      }
      const params = parseWindowStateParams({
        environmentId: environment.id,
        containerName,
        checks: hostAccessChecks(environment.repository, this.deps.settings()),
        ...(options.branch
          ? { branch: { folder: repositoryFolder(environment.repository), ...(environment.remoteUser !== undefined && environment.remoteUser !== '' ? { user: environment.remoteUser } : {}) } }
          : {}),
      });
      if (params === undefined) throw new Error('its parameters are beyond the checks of the worker');
      const value = parseWindowStateValue(
        await this.deps.flow(
          OP_WINDOW_STATE,
          params,
          options.signal !== undefined
            ? { timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS, signal: options.signal }
            : { timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS, passive: true, signal: AbortSignal.timeout(WINDOW_STATE_FLOW_TIMEOUT_MS) },
        ),
      );
      if (value === undefined) throw new Error('the worker answered with an invalid value');
      return value;
    } catch (error) {
      this.logger.info(`The state of the container ${containerName} could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Plan step 11C3 (decisions of 2026-10-03 and 2026-10-04): concept 7.5 "registry lost" by the worker of the Docker host
   * of the operation (`reconcile`, where reconcileFromVolumes runs; the entries come back as `record restore`, which this
   * computer adds under its registry lock). Returns the number of added entries. Does not start Docker: 0 when it does not
   * run, and on an endpoint that is neither local nor SSH (review D2). `passive`: a call in the background; the worker is
   * made ready as for the refresh (the helper image only checked, the wait after a failed open kept). Throws when the
   * worker could not be reached or failed (nothing is added then).
   */
  async reconcileInWorker(options: { passive: boolean; signal?: AbortSignal }): Promise<number> {
    const readable = await this.readableDockerHost();
    if (readable === undefined) return 0;
    if (!(await this.deps.dockerRunning())) return 0;
    const params = parseReconcileParams({ dockerHost: readable, owner: this.deps.owner });
    if (params === undefined) throw new Error('The rebuild of the registry cannot be sent to the worker.');
    const value = parseReconcileValue(
      await this.deps.flow(OP_RECONCILE, params, { timeoutMs: RECONCILE_FLOW_TIMEOUT_MS, ...(options.passive ? { passive: true } : {}), ...(options.signal ? { signal: options.signal } : {}) }),
    );
    if (value === undefined) throw new Error('The worker answered the rebuild of the registry with an invalid value.');
    return value.added;
  }
}
