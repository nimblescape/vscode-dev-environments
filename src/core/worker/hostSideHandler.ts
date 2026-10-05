// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B (decision of 2026-10-03, the worker is the deputy): the extension's side of the requests of a flow in the
// worker (plan step 11A, `OperationOptions.onAsk`). It checks every request, calls the HostSide of this computer, and
// answers with its value; a `secret` request answers with the secret in `secrets`, never in the value. No `vscode` here:
// the extension passes its own HostSide (src/vscode).
import { DETAILED_REQUESTS, HOST_SECRET_NAMES, HOST_SESSION_FILES, SCOPED_REQUESTS, parseHostRequest, type HostCall, type HostSecretAnswer, type HostSessionFile, type HostSide } from './hostSide';
import { BUSY_OPERATIONS } from '../pipeline/busyMarks';
import type { DeleteConfirmation } from '../pipeline/deleteCheck';
import { sameBusyMark } from '../pipeline/openRecords';
import type { BusyMark, BusyOperation, Environment } from '../types';
import {
  VOLUME_NAME,
  busyMarkFields,
  checkedBuildChange,
  checkedBusyMark,
  checkedConfigurationChange,
  checkedCreateRequest,
  checkedGitSummary,
  checkedLifecycleChange,
  checkedOpenFinish,
  type OpenRequestScope,
} from './openRequests';
import { MAX_RESTORE_ENTRIES } from '../helperChannel/protocol';
import { isConfigPathLabelValue, repositoryFolder, resourceName } from '../names';
import { DEFAULT_CONFIG_PATH, isRepositoryName } from '../pipeline/recordRules';
import { boundServiceFolders, MAX_SERVICE_FOLDERS, MAX_SERVICE_PATH_LENGTH } from '../git/gitSummary';
import { dockerHostField } from '../docker/dockerHost';
import { isStorageId } from '../storage/paths';
import { HelperOperationError, type OperationOptions } from '../helperChannel/helperChannel';
import type { AskKind, Secrets } from '../helperChannel/protocol';
import { errorMessage } from '../errors';
import type { Logger } from '../ports';

/** The answer of a request: its value, and the secrets that the operation gets with it. */
type Answer = { value: unknown; secrets?: Secrets };

/** A registry as Docker names it: a host name, with a port. */
const REGISTRY_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/i;
/** The longest text of a message of a flow. */
const MAX_MESSAGE_CHARACTERS = 2000;

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Plan step 11B: `onAsk` of an operation that runs a flow: it answers the requests of `HostSide` of this computer. A
 * request that it does not know, or whose arguments do not fit, is refused with the code `invalid`; a call that throws is
 * refused with `failed` (its message), so the flow in the worker sees the failure of its call. Review round 1 of plan
 * step 11B1 (A-R1-8): only the requests in `allowed` (FLOW_REQUESTS of the operation) are answered; everything else is
 * refused before this computer is touched.
 */
export function hostSideHandler(
  host: HostSide,
  logger: Logger,
  allowed: readonly HostCall[],
  // Plan step 11C2a: the environment of the operation, for the requests that change one (SCOPED_REQUESTS). Review round 1
  // of 11C2b (A-R1-M1, A-R1-M2): the name of the repository that the questions must name, and the observer of the answers
  // of the user (the extension checks the decision of the flow against them).
  scope: {
    environmentId?: string;
    repository?: string;
    // Plan step 11C3: the Docker host of the operation, the only one whose entries `record restore` adds.
    dockerHost?: string;
    onAnswer?: (call: string, args: unknown[], value: unknown) => void;
    // Review round 3 of 11C2b (A-R3-L1): a question of the flow is asked (`asked`) and has its answer or failed (`settled`).
    onQuestion?: (state: 'asked' | 'settled') => void;
  } = {},
): NonNullable<OperationOptions['onAsk']> {
  const permitted = new Set<string>(allowed);
  // Review round 1 of 11C3 (A-R1-L1): the requests that an operation sends at most once.
  const sent = new Set<string>();
  // Plan step 11E4b: the marks that a `record markBusy` of this operation replaced, the only ones that `record
  // createMark` `previous` gives back.
  const replaced: BusyMark[] = [];
  // Plan step 11E4c: the environment of the operation; a first open has none until its `record createEnvironment` binds
  // it (`created`: the entry that this operation created, the only one that `record dropCreated` removes).
  const environment: OperationEnvironment = { id: scope.environmentId };
  return async (kind, payload, signal) => {
    const request = parseHostRequest(payload, kind);
    if (request === undefined) throw new HelperOperationError('invalid', 'The request of the operation is invalid.', false);
    const name = `${request.kind} ${request.call}` as HostCall;
    // Review round 1 of 11C2a (A-R1-L1, A-R1-L4): an allowance can name the kind of a request (its session file, its busy
    // operation).
    const detailAt = Object.hasOwn(DETAILED_REQUESTS, name) ? DETAILED_REQUESTS[name] : undefined;
    const detail = detailAt !== undefined ? request.args[detailAt] : undefined;
    if (!permitted.has(name) && !(typeof detail === 'string' && permitted.has(`${name}.${detail}`))) {
      logger.warn(`The worker sent the request ${request.kind} ${request.call}, which its operation may not send.`);
      throw new HelperOperationError('invalid', `The operation may not send the request ${request.kind} ${request.call}.`, false);
    }
    const scoped = Object.hasOwn(SCOPED_REQUESTS, name) ? SCOPED_REQUESTS[name] : undefined;
    if (scoped !== undefined && (environment.id === undefined || request.args[scoped] !== environment.id)) {
      logger.warn(`The worker sent the request ${request.kind} ${request.call} for another environment than the one of its operation.`);
      throw new HelperOperationError('invalid', `The request ${request.kind} ${request.call} is for another environment than the one of the operation.`, false);
    }
    if (ONCE_REQUESTS.has(name)) {
      if (sent.has(name)) {
        logger.warn(`The worker sent the request ${request.kind} ${request.call} again, which its operation sends once.`);
        throw new HelperOperationError('invalid', `The operation sends the request ${request.kind} ${request.call} only once.`, false);
      }
      sent.add(name);
    }
    if (signal.aborted) throw new HelperOperationError('cancelled', 'The operation ended.', false);
    try {
      // Review round 1 of 11C2b (A-R1-M2): a question names the repository of the operation, never a text of the worker.
      // Plan step 11E6: as the registry compares repositories (isEnvironmentOf), without case: the entry of the open may spell
      // its repository otherwise than the target of the operation.
      if (request.kind === 'question' && QUESTIONS_WITH_REPOSITORY.has(request.call) && scope.repository !== undefined && !sameRepository(request.args[0], scope.repository)) {
        throw new HelperOperationError('invalid', `The question ${request.call} names another repository than the one of the operation.`, false);
      }
      if (request.kind !== 'question') return await answer(host, request.kind, request.call, request.args, { dockerHost: scope.dockerHost, repository: scope.repository, logger, replaced, environment });
      scope.onQuestion?.('asked');
      try {
        const answered = await answer(host, request.kind, request.call, request.args);
        scope.onAnswer?.(request.call, request.args, answered.value);
        return answered;
      } finally {
        scope.onQuestion?.('settled');
      }
    } catch (error) {
      if (error instanceof HelperOperationError) throw error;
      logger.warn(`The request ${request.kind} ${request.call} of the worker failed: ${errorMessage(error)}`);
      throw new HelperOperationError('failed', errorMessage(error), false);
    }
  };
}

/**
 * Review round 1 of 11C3 (A-R1-L1): the requests that an operation sends at most once: the restore of the registry adds
 * the entries of one engine, so a worker cannot grow the registry without bound.
 */
const ONCE_REQUESTS: ReadonlySet<string> = new Set([
  'record restore',
  // Plan step 11E4b: an open ends once.
  'record openFinished',
  // Plan step 11E4c: an operation creates at most one environment.
  'record createEnvironment',
  // Review round 1 of PR #107 (A-L3): one question to GitHub with the user's token per operation (identityOf asks once).
  'local viewer',
]);

/** Plan step 11E4c: the environment of an operation (SCOPED_REQUESTS), and the one that it created. */
interface OperationEnvironment {
  id?: string;
  created?: string;
}

/** What the answer of a request of the extension's side knows of its operation (hostSideHandler). */
interface RequestContext {
  dockerHost?: string;
  repository?: string;
  logger?: Logger;
  replaced: BusyMark[];
  environment: OperationEnvironment;
}

/** Plan step 11E4b: the most marks that the handler of an operation remembers as replaced by its `record markBusy`. */
const MAX_REPLACED_MARKS = 8;

/** Plan step 11E6: the same repository, as the registry compares them (isEnvironmentOf: without case). */
function sameRepository(value: unknown, repository: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === repository.toLowerCase();
}

/**
 * Review round 1 of 11C2b (A-R1-M2): the questions whose first argument is the name of the repository. Plan step 11E6: the
 * questions of the open too (a worker never asks the trust, or a rebuild, for another repository than the one of its
 * operation).
 */
const QUESTIONS_WITH_REPOSITORY = new Set(['confirmDelete', 'confirmUntrustedRepository', 'configurationChanged', 'configurationKindChanged', 'filesMissing', 'recreateContainer']);

/** The most names of a question of Delete. */
const MAX_QUESTION_NAMES = 1000;

// Review round 2 of 11C2b (B-R2 HH2): every caller names its limit.
function plainText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Plan step 11C2b: the volume names of a question of Delete. */
function volumeNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_QUESTION_NAMES || !value.every((name) => typeof name === 'string' && VOLUME_NAME.test(name))) {
    throw new HelperOperationError('invalid', 'The volumes of the question are invalid.', false);
  }
  return [...(value as string[])];
}

/** Plan step 11C2b: the facts of the confirmation of Delete (DeleteConfirmation), checked; nothing else is passed on. */
function deleteConfirmation(value: unknown): DeleteConfirmation {
  const invalid = () => new HelperOperationError('invalid', 'The confirmation of Delete is invalid.', false);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const { changes, recordedAt, lastSeenInUse, repositoryData, otherWindow } = value as Record<string, unknown>;
  if (typeof otherWindow !== 'boolean') throw invalid();
  // Review round 1 of 11C2b (A-R1-M2): counts, never a text.
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  let counts: DeleteConfirmation['changes'];
  if (changes !== undefined) {
    if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) throw invalid();
    const { uncommittedFiles, unpushedCommits, stashes } = changes as Record<string, unknown>;
    if (!count(uncommittedFiles) || !count(unpushedCommits) || (stashes !== undefined && !count(stashes))) throw invalid();
    counts = { uncommittedFiles: uncommittedFiles as number, unpushedCommits: unpushedCommits as number, ...(stashes !== undefined ? { stashes: stashes as number } : {}) };
  }
  for (const time of [recordedAt, lastSeenInUse]) if (time !== undefined && !plainText(time, 64)) throw invalid();
  // Review round 2 of 11C2b (A-R2-L-a): folders of the repository, as paths of normal length without `..`.
  const isFolder = (folder: unknown) => plainText(folder, 255) && folder !== '' && !(folder as string).split('/').includes('..');
  if (!Array.isArray(repositoryData) || repositoryData.length > MAX_QUESTION_NAMES || !repositoryData.every(isFolder)) throw invalid();
  return {
    ...(counts !== undefined ? { changes: counts } : {}),
    ...(recordedAt !== undefined ? { recordedAt: recordedAt as string } : {}),
    ...(lastSeenInUse !== undefined ? { lastSeenInUse: lastSeenInUse as string } : {}),
    repositoryData: [...(repositoryData as string[])],
    otherWindow,
  };
}

/** The fields of an entry that the rebuild from the volumes gives it (EnvironmentService.reconcileFromVolumes). */
const RESTORED_FIELDS = new Set([
  'id',
  'repository',
  'configPath',
  'volumeName',
  'containerName',
  'createdAt',
  'lastUsedAt',
  'owner',
  'dockerHost',
  'additionalVolumes',
  'serviceVolumes',
  'serviceFolders',
  'serviceFoldersOverflow',
]);

/** Review round 1 of 11C3 (A-R1-M1): why one restored entry is left out. */
class RefusedEntry extends Error {}

/**
 * Plan step 11C3 (decision of 2026-10-04: `record restore`): the entries that the worker rebuilt from the labels of the
 * volumes, checked as reconcileFromVolumes makes them: the name of the volume that the extension gives the environment
 * of its labels, an owner without login, the Docker host of the operation, and only the fields of a rebuild (no build
 * record, no Git state, no busy mark). Each entry is rebuilt from its checked fields; nothing else is passed on. Review
 * round 1 of 11C3 (A-R1-M1): an entry that does not fit is left out (logged), never the others with it; only a request
 * that is not a list of at most MAX_RESTORE_ENTRIES is refused.
 */
function restoredEntries(value: unknown, dockerHost: string, logger: Logger | undefined): Environment[] {
  if (!Array.isArray(value) || value.length > MAX_RESTORE_ENTRIES) {
    throw new HelperOperationError('invalid', `The restored entries are invalid: not a list of at most ${MAX_RESTORE_ENTRIES}.`, false);
  }
  const entries: Environment[] = [];
  for (const entry of value as unknown[]) {
    try {
      entries.push(restoredEntry(entry, dockerHost));
    } catch (error) {
      if (!(error instanceof RefusedEntry)) throw error;
      // The name only when it is a volume name (the worker's text is never logged as it is).
      const name = typeof entry === 'object' && entry !== null ? (entry as { volumeName?: unknown }).volumeName : undefined;
      const named = typeof name === 'string' && VOLUME_NAME.test(name) ? `of the volume ${name} ` : '';
      logger?.warn(`The worker restored an entry ${named}that is left out: ${error.message}.`);
    }
  }
  return entries;
}

/** Review round 1 of 11C3 (A-R1-M1): one restored entry, checked and rebuilt; RefusedEntry when it does not fit. */
function restoredEntry(entry: unknown, dockerHost: string): Environment {
  const invalid = (why: string) => new RefusedEntry(why);
  const isTime = (time: unknown) => plainText(time, 64) && Number.isFinite(Date.parse(time));
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw invalid('it is not an object');
  const fields = entry as Record<string, unknown>;
  const odd = Object.keys(fields).find((key) => !RESTORED_FIELDS.has(key));
  if (odd !== undefined) throw invalid('a field is not one of a restored entry');
  const { id, repository, configPath, volumeName, containerName, createdAt, lastUsedAt, owner } = fields;
  if (!isStorageId(id) || !isRepositoryName(repository) || !plainText(repository, 256)) throw invalid('its ID or repository');
  // Only the volume of the name that the extension gives the environment of these labels, and its container.
  if (typeof volumeName !== 'string' || volumeName.toLowerCase() !== resourceName(repository, id).toLowerCase() || containerName !== volumeName) {
    throw invalid('its volume has not the name of its environment');
  }
  if (typeof configPath !== 'string' || (configPath !== DEFAULT_CONFIG_PATH && !isConfigPathLabelValue(configPath))) throw invalid('its configuration path');
  if (!isTime(createdAt) || !isTime(lastUsedAt)) throw invalid('a time');
  if (typeof owner !== 'object' || owner === null || Array.isArray(owner)) throw invalid('its owner');
  const { id: ownerId, login, ...rest } = owner as Record<string, unknown>;
  // The owner label gives the entry its owner again; its login follows at the next open.
  if (!isStorageId(ownerId) || login !== '' || Object.keys(rest).length > 0) throw invalid('its owner');
  if ((fields.dockerHost ?? '') !== dockerHost || fields.dockerHost === '') throw invalid('its Docker host is not the one of the operation');
  const additional = fields.additionalVolumes === undefined ? [] : volumeList(fields.additionalVolumes, invalid);
  if (fields.additionalVolumes !== undefined && (additional.length === 0 || additional.includes(volumeName) || new Set(additional).size !== additional.length)) {
    throw invalid('its additional volumes');
  }
  const services = fields.serviceVolumes === undefined ? [] : volumeList(fields.serviceVolumes, invalid);
  if (fields.serviceVolumes !== undefined && (services.length === 0 || !services.every((name) => additional.includes(name)))) throw invalid('the volumes of its services');
  const { serviceFolders, serviceFoldersOverflow } = fields;
  if (serviceFoldersOverflow !== undefined && serviceFoldersOverflow !== true) throw invalid('the overflow of its service folders');
  // Review round 1 of 11C3 (A-R1-M1): service folders that do not fit count as overflow (the whole repository is left to
  // the services, so their data never loses its owner), as the pipeline counts paths beyond its bounds.
  const listed = Array.isArray(serviceFolders) ? serviceFolders.slice(0, MAX_SERVICE_FOLDERS) : [];
  const fitting = listed.filter((folder): folder is string => plainText(folder, MAX_SERVICE_PATH_LENGTH));
  const overflow =
    serviceFoldersOverflow === true || (serviceFolders !== undefined && !Array.isArray(serviceFolders)) || (Array.isArray(serviceFolders) && serviceFolders.length > MAX_SERVICE_FOLDERS) || fitting.length < listed.length;
  // As the pipeline records them: only paths of the repository, within the bounds.
  const folders = boundServiceFolders(repositoryFolder(repository), [fitting], overflow);
  return {
    id,
    repository,
    configPath,
    volumeName,
    containerName: volumeName,
    createdAt: createdAt as string,
    lastUsedAt: lastUsedAt as string,
    owner: { id: ownerId, login: '' },
    ...dockerHostField(dockerHost),
    ...(additional.length > 0 ? { additionalVolumes: additional } : {}),
    ...(services.length > 0 ? { serviceVolumes: services } : {}),
    ...(folders.folders.length > 0 ? { serviceFolders: folders.folders } : {}),
    ...(folders.overflow ? { serviceFoldersOverflow: true } : {}),
  };
}

/** Plan step 11C3: the names of volumes of a restored entry. */
function volumeList(value: unknown, invalid: (why: string) => Error): string[] {
  if (!Array.isArray(value) || value.length > MAX_QUESTION_NAMES || !value.every((name) => typeof name === 'string' && VOLUME_NAME.test(name))) throw invalid('the names of volumes');
  return [...(value as string[])];
}

function strings(args: unknown[], count: number): string[] {
  const values = args.slice(0, count);
  if (values.length !== count || !values.every((value) => typeof value === 'string')) {
    throw new HelperOperationError('invalid', 'The arguments of the request are invalid.', false);
  }
  return values as string[];
}

async function answer(host: HostSide, kind: AskKind, call: string, args: unknown[], context: RequestContext = { replaced: [], environment: {} }): Promise<Answer> {
  switch (kind) {
    case 'question':
      return { value: await question(host, call, args) };
    case 'local':
      return { value: await local(host, call, args) };
    case 'record':
      return { value: await record(host, call, args, context) };
    case 'secret':
      return secret(host, call, args);
  }
}

async function question(host: HostSide, call: string, args: unknown[]): Promise<unknown> {
  const ui = host.questions;
  switch (call) {
    case 'confirmUntrustedRepository':
      return ui.confirmUntrustedRepository(strings(args, 1)[0]);
    case 'configurationChanged':
      return ui.configurationChanged(strings(args, 1)[0]);
    case 'configurationKindChanged': {
      const [repository, message] = strings(args, 2);
      return ui.configurationKindChanged(repository, message);
    }
    case 'filesMissing':
      return (await ui.filesMissing(strings(args, 1)[0])) ?? null;
    case 'recreateContainer': {
      const [repository] = strings(args, 1);
      const value = args[1] as { message?: unknown; detail?: unknown } | undefined;
      if (typeof value !== 'object' || value === null || typeof value.message !== 'string' || typeof value.detail !== 'string') {
        throw new HelperOperationError('invalid', 'The question of the recreate offer is invalid.', false);
      }
      return ui.recreateContainer(repository, { message: value.message, detail: value.detail });
    }
    // Plan step 11C2b: the questions of Delete, with their facts checked.
    case 'confirmDelete': {
      const [repository] = strings(args, 1);
      if (!plainText(repository, 256) || repository === '') throw new HelperOperationError('invalid', 'The repository of the question is invalid.', false);
      return (await ui.confirmDelete(repository, deleteConfirmation(args[1]))) ?? null;
    }
    case 'deleteAdditionalVolumes':
      return (await ui.deleteAdditionalVolumes(volumeNames(args[0]))) ?? null;
    case 'deleteServiceData': {
      const volumes = volumeNames(args[0]);
      const possibly = volumeNames(args[1]);
      return (await ui.deleteServiceData(volumes, possibly)) ?? null;
    }
    case 'message': {
      const [kind, text] = strings(args, 2);
      if (kind !== 'info' && kind !== 'warn' && kind !== 'registrySignIn') throw new HelperOperationError('invalid', `The message ${kind} is unknown.`, false);
      // Review round 1 of plan step 11B1 (A-R1-16): the sign-in hint names a registry (a host name), and no text is longer
      // than a message on screen can be.
      if (kind === 'registrySignIn' && !REGISTRY_HOST.test(text)) throw new HelperOperationError('invalid', 'The registry of the sign-in hint is invalid.', false);
      await ui.message(kind, text.length > MAX_MESSAGE_CHARACTERS ? `${text.slice(0, MAX_MESSAGE_CHARACTERS)}…` : text);
      return null;
    }
    default:
      throw new HelperOperationError('invalid', `The question ${call} is unknown.`, false);
  }
}

async function local(host: HostSide, call: string, args: unknown[]): Promise<unknown> {
  switch (call) {
    case 'windowStatuses':
      return host.state.windowStatuses();
    case 'pendings':
      return host.state.pendings();
    case 'settings':
      return host.state.settings();
    case 'processAlive': {
      const pid = args[0];
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new HelperOperationError('invalid', 'The process id is invalid.', false);
      return host.state.processAlive(pid);
    }
    // Plan step 11E4d: the profile of the signed-in account, read by the extension with its own token.
    case 'viewer': {
      argumentCount(args, 0);
      const viewer = await host.state.viewer();
      return viewer === undefined ? null : { databaseId: viewer.databaseId, login: viewer.login, name: viewer.name ?? null };
    }
    // Plan step 11E4d: the container that the window remembers for the environment of the operation (SCOPED_REQUESTS).
    case 'unrecordedLifecycle': {
      strings(args, 1);
      argumentCount(args, 1);
      return (await host.state.unrecordedLifecycle(args[0] as string)) ?? null;
    }
    case 'account': {
      const interactive = args[0];
      if (typeof interactive !== 'boolean') throw new HelperOperationError('invalid', 'The account request is invalid.', false);
      const account = await host.state.account(interactive);
      // Plan step 11B3b: the id and the login only.
      return account === undefined ? null : { id: account.id, login: account.login };
    }
    default:
      throw new HelperOperationError('invalid', `The state ${call} is unknown.`, false);
  }
}

/**
 * Plan step 11E4d: a container ID as Docker gives it: 64 hexadecimal digits, or a short one of at least 12 (a shorter
 * prefix would name other containers too: sameContainer).
 */
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

/** Plan step 11E4b: the arguments of a request of the open, exactly `count` of them (no field beyond its closed list). */
function argumentCount(args: unknown[], count: number): void {
  if (args.length !== count) throw new HelperOperationError('invalid', 'The arguments of the request are invalid.', false);
}

/** Plan step 11E4b: the scope of a request of the open, from the operation; an operation without a Docker host sends none. */
function openScope(dockerHost: string | undefined): OpenRequestScope {
  if (dockerHost === undefined) throw new HelperOperationError('invalid', 'The operation names no Docker host for the registry writes of the open.', false);
  return { dockerHost };
}

async function record(host: HostSide, call: string, args: unknown[], context: RequestContext): Promise<unknown> {
  const { dockerHost, logger, replaced } = context;
  const records = host.records;
  switch (call) {
    case 'read':
      return records.read();
    case 'list':
      return records.list();
    case 'get':
      return (await records.get(strings(args, 1)[0])) ?? null;
    case 'findForAccount': {
      const [repository, accountId, onHost] = strings(args, 3);
      // Plan step 11E6 (review round 2 of PR #106): an operation of a repository without its environment yet (the open
      // of a repository) is bound to the environment that it finds for the repository of the operation, the account
      // signed in here and the Docker host of the operation: the existing one, or the one that its `record restore` added.
      // Only then may it change that entry (SCOPED_REQUESTS); an operation that is bound already finds no other one.
      const bindable = context.repository !== undefined && sameRepository(repository, context.repository) && dockerHost !== undefined && onHost === dockerHost;
      if (bindable && context.environment.id === undefined) {
        const account = await host.state.account(false);
        if (account === undefined || account.id !== accountId) throw new HelperOperationError('invalid', 'The account of the request is not the one signed in.', false);
      }
      const found = await records.findForAccount(repository, accountId, onHost);
      if (found !== undefined && bindable) {
        if (context.environment.id === undefined) context.environment.id = found.id;
        else if (context.environment.id !== found.id) throw new HelperOperationError('invalid', 'The operation found another environment than its own.', false);
      }
      return found ?? null;
    }
    case 'remove': {
      const [id] = strings(args, 1);
      const volumes = (args[1] ?? {}) as { kept?: unknown; removed?: unknown };
      if (typeof volumes !== 'object' || Array.isArray(volumes) || (volumes.kept !== undefined && !stringList(volumes.kept)) || (volumes.removed !== undefined && !stringList(volumes.removed))) {
        throw new HelperOperationError('invalid', 'The volumes of the removal are invalid.', false);
      }
      await records.remove(id, { ...(volumes.kept !== undefined ? { kept: volumes.kept } : {}), ...(volumes.removed !== undefined ? { removed: volumes.removed } : {}) });
      return null;
    }
    case 'forgetKeptVolumes': {
      const names = args[0];
      // Review round 1 of PR #111 (A-L2): volume names, at most as many as a question names (the worker reads which kept
      // volumes are gone from its engine; it holds that engine anyway, so the records are no more than its word).
      if (!stringList(names) || names.length > MAX_QUESTION_NAMES || !names.every((name) => VOLUME_NAME.test(name))) {
        throw new HelperOperationError('invalid', 'The volume names are invalid.', false);
      }
      await records.forgetKeptVolumes(names as string[]);
      return null;
    }
    case 'sessionFile': {
      const [kind, environmentId] = strings(args, 2);
      if (!(HOST_SESSION_FILES as readonly string[]).includes(kind)) throw new HelperOperationError('invalid', `The session file ${kind} is unknown.`, false);
      await records.sessionFile(kind as HostSessionFile, environmentId);
      return null;
    }
    // Plan step 11C2a (decision of 2026-10-04): the busy mark of the window that sent the operation.
    case 'markBusy': {
      const [environmentId, operation] = strings(args, 2);
      if (!(BUSY_OPERATIONS as readonly string[]).includes(operation)) throw new HelperOperationError('invalid', `The busy operation ${operation} is unknown.`, false);
      // Plan step 11E4b: the mark that it replaced is remembered for `record createMark` `previous` of this operation.
      const remember = (mark: BusyMark) => {
        replaced.push(mark);
        if (replaced.length > MAX_REPLACED_MARKS) replaced.shift();
      };
      return (await records.markBusy(environmentId, operation as BusyOperation, remember)) ?? null;
    }
    case 'clearBusy':
      await records.clearBusy(strings(args, 1)[0]);
      return null;
    // Plan step 11C2b: the Git state, checked as the registry checks it.
    case 'recordGitSummary': {
      const [environmentId] = strings(args, 1);
      // Review round 1 of 11C2b (A-R1-L2): its five fields only, a bounded branch and a valid time (plan step 11E4b:
      // checkedGitSummary, which `record openFinished` uses too).
      await records.recordGitSummary(environmentId, checkedGitSummary(args[1]));
      return null;
    }
    // Plan step 11C3: the entries rebuilt from the volumes of the engine of the operation, each rebuilt here from its checked fields.
    case 'restore': {
      if (dockerHost === undefined) throw new HelperOperationError('invalid', 'The operation names no Docker host for the restored entries.', false);
      const entries = restoredEntries(args[0], dockerHost, logger);
      const { added, skipped } = await records.restore(entries);
      return { added, skipped: [...skipped] };
    }
    // Plan step 11E4b (decision of 2026-10-04): the registry writes of the open, each with its closed list of arguments;
    // the extension applies them under its registry lock (requestOpenRecords).
    case 'createMark': {
      const [environmentId, kind] = strings(args, 2);
      if (kind === 'ended') {
        argumentCount(args, 2);
        return (await records.createMark(environmentId, 'ended', undefined, openScope(dockerHost))) ?? null;
      }
      if (kind !== 'previous' || args.length > 3) throw new HelperOperationError('invalid', 'The create mark of the request is invalid.', false);
      // `previous` only as a mark that a `record markBusy` of this operation replaced; the remembered one is given back,
      // never the worker's object. Review round 1 of PR #105 (A-L1): it is found by its four fields as the registry held
      // them (the worker read it there); one that is not found ends this window's create mark instead (`ended`), so the
      // mark never stays live for the rest of the window.
      let previous: BusyMark | undefined;
      if (args.length === 3) {
        const sent = busyMarkFields(args[2]);
        previous = sent === undefined ? undefined : replaced.find((mark) => sameBusyMark(mark, sent));
        if (previous === undefined) {
          logger?.warn(`The previous busy mark of ${environmentId} is not one that the busy mark of this operation replaced; the create mark of this window is ended instead.`);
          return (await records.createMark(environmentId, 'ended', undefined, openScope(dockerHost))) ?? null;
        }
      }
      return (await records.createMark(environmentId, 'previous', previous, openScope(dockerHost))) ?? null;
    }
    case 'stepMark': {
      const [environmentId, kind] = strings(args, 2);
      argumentCount(args, 3);
      if (kind === 'take') {
        // Review round 1 of PR #105 (A-L3): the open takes only an `update` step mark.
        if (args[2] !== 'update') throw new HelperOperationError('invalid', 'The busy operation of the step mark is not update.', false);
        return (await records.takeStepMark(environmentId, 'update', openScope(dockerHost))) ?? null;
      }
      if (kind !== 'release') throw new HelperOperationError('invalid', 'The step mark of the request is invalid.', false);
      return (await records.releaseStepMark(environmentId, checkedBusyMark(args[2]), openScope(dockerHost))) ?? null;
    }
    case 'ownerLogin': {
      const [environmentId] = strings(args, 1);
      // The account is the one signed in in the extension; the worker sends none.
      argumentCount(args, 1);
      return (await records.ownerLogin(environmentId, openScope(dockerHost))) ?? null;
    }
    case 'lifecycleMark': {
      const [environmentId] = strings(args, 1);
      argumentCount(args, 2);
      return (await records.lifecycleMark(environmentId, checkedLifecycleChange(args[1]), openScope(dockerHost))) ?? null;
    }
    case 'openFinished': {
      const [environmentId] = strings(args, 1);
      argumentCount(args, 2);
      return (await records.openFinished(environmentId, checkedOpenFinish(args[1]), openScope(dockerHost))) ?? null;
    }
    // Plan step 11E4c (decision of 2026-10-04): the entry of a first open, the worker's ID and the repository of the
    // operation; the extension builds the entry. The operation is bound to the environment of the answer.
    case 'createEnvironment': {
      argumentCount(args, 1);
      if (context.environment.id !== undefined) throw new HelperOperationError('invalid', 'The operation has an environment already: it creates none.', false);
      const request = checkedCreateRequest(args[0]);
      // Review round 1 of PR #106 (A-L1): only an operation of a repository creates its entry.
      if (context.repository === undefined || request.repository !== context.repository) {
        throw new HelperOperationError('invalid', 'The environment of the request is of another repository than the one of the operation.', false);
      }
      const entry = await records.createEnvironment(request.id, request.repository, request.configPath, openScope(dockerHost));
      // The new entry, or the one of the repository of the account on the Docker host that another window created
      // meanwhile (the open uses it, as openFirst does): every later request of the operation is for it.
      context.environment.id = entry.id;
      if (entry.id === request.id) context.environment.created = entry.id;
      return entry;
    }
    case 'dropCreated': {
      const [environmentId] = strings(args, 1);
      argumentCount(args, 1);
      if (environmentId !== context.environment.created) throw new HelperOperationError('invalid', 'The environment of the request is not the one that the operation created.', false);
      await records.dropCreated(environmentId, openScope(dockerHost));
      context.environment.created = undefined;
      return null;
    }
    case 'configuration': {
      const [environmentId] = strings(args, 1);
      argumentCount(args, 2);
      return (await records.configuration(environmentId, checkedConfigurationChange(args[1]), openScope(dockerHost))) ?? null;
    }
    case 'build': {
      const [environmentId, kind] = strings(args, 2);
      return (await records.build(environmentId, checkedBuildChange(kind, args.slice(2)), openScope(dockerHost))) ?? null;
    }
    // Plan step 11E4d (decision of 2026-09-29): the window's memory of a container of the environment of the operation
    // whose lifecycle mark could not be recorded; only a container ID.
    case 'rememberLifecycle':
    case 'forgetLifecycle': {
      const [environmentId, containerId] = strings(args, 2);
      argumentCount(args, 2);
      if (!CONTAINER_ID.test(containerId)) throw new HelperOperationError('invalid', 'The container ID of the request is invalid.', false);
      if (call === 'rememberLifecycle') await records.rememberLifecycle(environmentId, containerId);
      else await records.forgetLifecycle(environmentId, containerId);
      return null;
    }
    default:
      throw new HelperOperationError('invalid', `The record ${call} is unknown.`, false);
  }
}

async function secret(host: HostSide, call: string, args: unknown[]): Promise<Answer> {
  switch (call) {
    case 'token': {
      const token = await host.secrets.token();
      const value: HostSecretAnswer = { given: token !== undefined };
      return token === undefined ? { value } : { value, secrets: { [HOST_SECRET_NAMES.token]: token } };
    }
    case 'registry': {
      const login = await host.secrets.registry(strings(args, 1)[0]);
      if (login === undefined) return { value: { given: false } satisfies HostSecretAnswer };
      const { password, ...rest } = login;
      const value: HostSecretAnswer = { given: true, ...rest };
      return { value, secrets: { [HOST_SECRET_NAMES.registry]: password } };
    }
    default:
      throw new HelperOperationError('invalid', `The secret ${call} is unknown.`, false);
  }
}
