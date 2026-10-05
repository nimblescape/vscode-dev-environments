// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E4b (decision of 2026-10-04, one operations interface in both directions): the registry writes of the open
// that the worker sends as requests (`record createMark`, `record stepMark`, `record ownerLogin`, `record lifecycleMark`,
// `record openFinished`), as the extension checks and applies them. The checks of their payloads (closed lists of
// fields, each bounded; nothing of the worker is passed on as it is) are here for hostSideHandler; the writes run under
// the registry lock of the extension with its owner, clock, signed-in account and view of the windows, only on the entry
// of the operation's environment, owned by that account and on the operation's Docker host (requestOpenRecords).
// Pure over its deps; no `vscode`.
import { EXEC_USER } from '../helperChannel/protocol';
import { isGitSummary } from '../git/gitSummary';
import { HelperOperationError } from '../helperChannel/helperChannel';
import { isOnDockerHost } from '../docker/dockerHost';
import { isoTime } from '../ports';
import type { BusyMark, BusyOperation, Environment, GitHubAccount, GitSummary } from '../types';
import type { EnvironmentRegistry } from '../storage/registry';
import { BUSY_OPERATIONS, type BusyMarkView } from '../pipeline/busyMarks';
import { readLiveness, registryOpenRecords, type LifecycleMarkChange, type OpenFinish, type StepMarkResult } from '../pipeline/openRecords';

/**
 * What the worker sends of the end of an open (OpenFinish): the time of the last use and the liveness of the marks are
 * the extension's own (its clock, its view of the windows), never the worker's.
 */
export type HostOpenFinish = Omit<OpenFinish, 'lastUsedAt' | 'liveness'>;

/**
 * The scope of a request of the open, which the extension's handler gives it from the operation (never from the
 * request): the Docker host of the operation. The environment of the operation is checked by SCOPED_REQUESTS.
 */
export interface OpenRequestScope {
  dockerHost: string;
}

/** A container ID as Docker gives it (12 to 64 hex digits). */
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
/** The longest window ID of a busy mark. */
const MAX_WINDOW_ID_LENGTH = 256;
/** The longest time of a busy mark or a Git state. */
const MAX_TIME_LENGTH = 64;
/** The longest remote workspace folder. */
const MAX_FOLDER_LENGTH = 4096;
/** The fields of a busy mark (BusyMark). */
const BUSY_MARK_FIELDS = new Set(['operation', 'since', 'pid', 'windowId']);
/** The fields of the end of an open that the worker sends (HostOpenFinish). */
const FINISH_FIELDS = new Set(['lifecycleMarkRead', 'lifecycleRanFor', 'remoteUser', 'remoteWorkspaceFolder', 'gitSummary']);

function invalid(what: string): HelperOperationError {
  return new HelperOperationError('invalid', `The ${what} of the request is invalid.`, false);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plainText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTime(value: unknown): value is string {
  return plainText(value, MAX_TIME_LENGTH) && Number.isFinite(Date.parse(value));
}

/** True for a container ID of 12 to 64 hex digits. */
export function isContainerId(value: unknown): value is string {
  return typeof value === 'string' && CONTAINER_ID.test(value);
}

/**
 * Review round 1 of PR #105 (A-L1): the four fields of a busy mark as the registry may hold it (isBusyMark: any operation,
 * any time text, other keys allowed), each bounded, for the lookup of a remembered mark; undefined when they are not.
 */
export function busyMarkFields(value: unknown): BusyMark | undefined {
  if (!isPlainObject(value)) return undefined;
  const { operation, since, pid, windowId } = value;
  if (!plainText(operation, MAX_TIME_LENGTH) || !plainText(since, MAX_TIME_LENGTH) || !plainText(windowId, MAX_WINDOW_ID_LENGTH)) return undefined;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) return undefined;
  return { operation: operation as BusyOperation, since, pid, windowId };
}

/** A busy mark of a request: its four fields only, each bounded; rebuilt from them. */
export function checkedBusyMark(value: unknown): BusyMark {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !BUSY_MARK_FIELDS.has(key))) throw invalid('busy mark');
  const { operation, since, pid, windowId } = value;
  if (!(BUSY_OPERATIONS as readonly unknown[]).includes(operation) || !isTime(since)) throw invalid('busy mark');
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw invalid('busy mark');
  if (!plainText(windowId, MAX_WINDOW_ID_LENGTH) || windowId === '') throw invalid('busy mark');
  return { operation: operation as BusyOperation, since, pid, windowId };
}

/**
 * Plan step 11C2b, moved here by plan step 11E4b: the Git state of a request, checked as the registry checks it, with its
 * five fields only, a bounded branch and a valid time (review round 1 of 11C2b, A-R1-L2).
 */
export function checkedGitSummary(value: unknown): GitSummary {
  if (!isGitSummary(value)) throw new HelperOperationError('invalid', 'The Git state is invalid.', false);
  const { branch, uncommittedFiles, unpushedCommits, stashes, recordedAt } = value;
  if ((branch !== null && (branch.length > 255 || !plainText(branch, 255))) || !Number.isFinite(Date.parse(recordedAt)) || recordedAt.length > MAX_TIME_LENGTH) {
    throw new HelperOperationError('invalid', 'The Git state is invalid.', false);
  }
  return { branch, uncommittedFiles, unpushedCommits, stashes, recordedAt };
}

/** The change of the lifecycle mark of a request: `'clear'`, or `{ set }` with a container ID. */
export function checkedLifecycleChange(value: unknown): LifecycleMarkChange {
  if (value === 'clear') return 'clear';
  if (!isPlainObject(value) || Object.keys(value).length !== 1 || !isContainerId(value.set)) throw invalid('lifecycle mark');
  return { set: value.set };
}

/**
 * The end of an open of a request (HostOpenFinish): its closed list of fields, each checked; the time and the liveness
 * are not among them (the extension takes its own).
 */
export function checkedOpenFinish(value: unknown): HostOpenFinish {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !FINISH_FIELDS.has(key))) throw invalid('end of the open');
  const { lifecycleMarkRead, lifecycleRanFor, remoteUser, remoteWorkspaceFolder, gitSummary } = value;
  if (lifecycleMarkRead !== undefined && !isContainerId(lifecycleMarkRead)) throw invalid('lifecycle mark of the end of the open');
  if (lifecycleRanFor !== undefined && !isContainerId(lifecycleRanFor)) throw invalid('container of the end of the open');
  // Review round 1 of PR #105 (A-L2): the user as `docker exec -u` takes it (EXEC_USER), the one rule of the system.
  if (remoteUser !== undefined && (typeof remoteUser !== 'string' || !EXEC_USER.test(remoteUser))) throw invalid('remote user');
  if (
    !plainText(remoteWorkspaceFolder, MAX_FOLDER_LENGTH) ||
    !remoteWorkspaceFolder.startsWith('/') ||
    remoteWorkspaceFolder.split('/').includes('..')
  ) {
    throw invalid('remote workspace folder');
  }
  return {
    ...(lifecycleMarkRead !== undefined ? { lifecycleMarkRead } : {}),
    ...(lifecycleRanFor !== undefined ? { lifecycleRanFor } : {}),
    ...(remoteUser !== undefined ? { remoteUser } : {}),
    remoteWorkspaceFolder,
    ...(gitSummary !== undefined ? { gitSummary: checkedGitSummary(gitSummary) } : {}),
  };
}

/** The writes of the open that the extension applies for a request of the worker (requestOpenRecords). */
export interface OpenRequests {
  /** OpenRecords.createMark; `ended` only over a create mark of this window. */
  createMark(environmentId: string, kind: 'ended' | 'previous', previous?: BusyMark): Promise<Environment | undefined>;
  /** OpenRecords.takeStepMark: the mark of this window, with its clock and its view of the windows. */
  takeStepMark(environmentId: string, operation: BusyOperation): Promise<StepMarkResult>;
  /** OpenRecords.releaseStepMark, only for a mark of this window. */
  releaseStepMark(environmentId: string, mark: BusyMark): Promise<Environment | undefined>;
  /** OpenRecords.ownerLogin with the signed-in account of this window. */
  ownerLogin(environmentId: string): Promise<Environment | undefined>;
  lifecycleMark(environmentId: string, change: LifecycleMarkChange): Promise<Environment | undefined>;
  /** OpenRecords.openFinished with the clock and the liveness of this window. */
  openFinished(environmentId: string, finish: HostOpenFinish): Promise<Environment | undefined>;
}

/**
 * The writes of the open for the requests of the worker, over the registry of this computer: the rules of
 * registryOpenRecords with this window's owner, clock and liveness (`view`), each only on an entry of `account` on
 * `dockerHost`, checked under the registry lock (an entry that does not fit is refused, nothing is written). A missing
 * entry is `undefined`, as in OpenRecords.
 */
export function requestOpenRecords(
  registry: Pick<EnvironmentRegistry, 'updateEnvironment'>,
  view: BusyMarkView,
  scope: { account: GitHubAccount; dockerHost: string },
): OpenRequests {
  const isOwnMark = (mark: BusyMark) => mark.windowId === view.owner.windowId && mark.pid === view.owner.pid;
  // The checks of every request under the lock, before the rule of registryOpenRecords; `also` adds the check of one.
  const records = (also?: (entry: Environment) => void) =>
    registryOpenRecords(
      {
        add: async () => {
          throw new Error('A request of the open adds no entry before plan step 11E4c.');
        },
        remove: async () => {
          throw new Error('A request of the open removes no entry before plan step 11E4c.');
        },
        updateEnvironment: (id, mutator) =>
          registry.updateEnvironment(id, async (entry) => {
            if (entry.owner.id !== scope.account.id) {
              throw new HelperOperationError('invalid', 'The environment of the request belongs to another account than the one signed in.', false);
            }
            if (!isOnDockerHost(entry, scope.dockerHost)) {
              throw new HelperOperationError('invalid', 'The environment of the request is on another Docker host than the one of the operation.', false);
            }
            also?.(entry);
            await mutator(entry);
          }),
      },
      view,
    );
  // Both kinds only over a create mark of this window (review round 2 of PR #105, A2-L1: `previous` too).
  const onlyOverOwnCreateMark = (entry: Environment) => {
    if (entry.busy && isOwnMark(entry.busy) && entry.busy.operation !== 'create') {
      throw new HelperOperationError('invalid', 'The busy mark of this window is not a create mark.', false);
    }
  };
  return {
    createMark: (environmentId, kind, previous) =>
      kind === 'ended'
        ? records(onlyOverOwnCreateMark).createMark(environmentId, 'ended')
        : records(onlyOverOwnCreateMark).createMark(environmentId, 'previous', previous),
    takeStepMark: (environmentId, operation) => records().takeStepMark(environmentId, operation),
    releaseStepMark: async (environmentId, mark) => {
      if (!isOwnMark(mark)) throw new HelperOperationError('invalid', 'The busy mark of the request is not one of this window.', false);
      return records().releaseStepMark(environmentId, mark);
    },
    ownerLogin: (environmentId) => records().ownerLogin(environmentId, scope.account),
    lifecycleMark: (environmentId, change) => records().lifecycleMark(environmentId, change),
    openFinished: async (environmentId, finish) => {
      // Review round 1 of PR #104 (A-L2): the liveness is read here, before the lock, never taken from the worker.
      const liveness = await readLiveness(view);
      return records().openFinished(environmentId, {
        ...(finish.lifecycleMarkRead !== undefined ? { lifecycleMarkRead: finish.lifecycleMarkRead } : {}),
        ...(finish.lifecycleRanFor !== undefined ? { lifecycleRanFor: finish.lifecycleRanFor } : {}),
        ...(finish.remoteUser !== undefined ? { remoteUser: finish.remoteUser } : {}),
        remoteWorkspaceFolder: finish.remoteWorkspaceFolder,
        ...(finish.gitSummary !== undefined ? { gitSummary: finish.gitSummary } : {}),
        lastUsedAt: isoTime(view.clock),
        liveness,
      });
    },
  };
}
