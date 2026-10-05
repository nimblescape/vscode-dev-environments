// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E4b (decision of 2026-10-04, one operations interface in both directions): the registry writes of the open
// that the worker sends as requests (`record createMark`, `record stepMark`, `record ownerLogin`, `record lifecycleMark`,
// `record openFinished`; plan step 11E4c: `record createEnvironment`, `record dropCreated`, `record configuration`,
// `record build`), as the extension checks and applies them. The checks of their payloads (closed lists of fields, each
// bounded; nothing of the worker is passed on as it is) are here for hostSideHandler; the writes run under the registry
// lock of the extension with its owner, clock, signed-in account and view of the windows, only on the entry of the
// operation's environment, owned by that account and on the operation's Docker host (requestOpenRecords).
// Pure over its deps; no `vscode`.
import { EXEC_USER, MAX_DELETE_VOLUMES } from '../helperChannel/protocol';
import { boundServiceFolders, isGitSummary, MAX_SERVICE_FOLDERS, MAX_SERVICE_PATH_LENGTH } from '../git/gitSummary';
import { HelperOperationError } from '../helperChannel/helperChannel';
import { dockerHostField, isOnDockerHost } from '../docker/dockerHost';
import { environmentImageName, isConfigPathLabelValue, repositoryFolder, resourceName } from '../names';
import { ownerOf } from '../ownership';
import { isoTime } from '../ports';
import type { BuildRecord, BusyMark, BusyOperation, ComposeBuildRecord, Environment, GitHubAccount, GitSummary, RefusedUpdate, RegistryFile } from '../types';
import { isBuildRecord, isEnvironmentOf, type EnvironmentRegistry } from '../storage/registry';
import { isStorageId } from '../storage/paths';
import { BUSY_OPERATIONS, type BusyMarkView } from '../pipeline/busyMarks';
import { buildRecordFits } from '../pipeline/imageRecord';
import { DEFAULT_CONFIG_PATH, isRepositoryName, MAX_REFUSED_ITEMS_LENGTH } from '../pipeline/pipelineRules';
import {
  readLiveness,
  registryOpenRecords,
  type BuildChange,
  type ConfigurationChange,
  type LifecycleMarkChange,
  type OpenFinish,
  type OpenRecords,
  type StepMarkResult,
} from '../pipeline/openRecords';

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
/** Plan step 11E4c: the fields of the entry of a first open that the worker sends (CreateRequest). */
const CREATE_FIELDS = new Set(['id', 'repository', 'configPath']);
/** Plan step 11E4c: the fields of a change of the configuration (ConfigurationChange). */
const CONFIGURATION_FIELDS = new Set(['select', 'shutdownActionNone', 'addVolumes', 'addServiceVolumes', 'keepRefusedFor', 'serviceFolders', 'cloned']);
/** Plan step 11E4c: the fields of a build record (BuildRecord) and of its Docker Compose part (ComposeBuildRecord). */
const BUILD_RECORD_FIELDS = new Set(['builtAt', 'environmentImage', 'imageId', 'buildNumber', 'configPath', 'configHash', 'images', 'features', 'compose']);
const COMPOSE_RECORD_FIELDS = new Set(['service', 'images', 'serviceImages', 'version', 'inputsHash']);
/** Plan step 11E4c: the fields of a refused update (RefusedUpdate). */
const REFUSED_FIELDS = new Set(['configPath', 'configHash', 'images', 'features', 'items', 'hostAccessChecks', 'reason']);
/** Plan step 11E4c: the longest repository name (as the restore takes it). */
const MAX_REPOSITORY_LENGTH = 256;
/** Plan step 11E4c: the longest configuration hash, model hash, or version of the Compose plugin. */
const MAX_HASH_LENGTH = 256;
/** Plan step 11E4c: the longest image or feature reference, image name, or Compose service. */
const MAX_REFERENCE_LENGTH = 1024;
/** Plan step 11E4c: the most image or feature references (or Compose images) of a build record or a refused update. */
const MAX_RECORD_REFERENCES = 1000;
/** Plan step 11E4c: a digest or an image ID as Docker gives it. */
const SHA256 = /^sha256:[0-9a-f]{64}$/;
/** A volume name as Docker takes it. */
export const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

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

/** Plan step 11E4c: the entry of a first open as the worker asks for it; the extension builds the rest. */
export interface CreateRequest {
  id: string;
  repository: string;
  configPath: string;
}

/** Plan step 11E4c: the default configuration, or the path of a configuration of a repository (as its label takes it). */
function isConfigPath(value: unknown): value is string {
  return typeof value === 'string' && (value === DEFAULT_CONFIG_PATH || isConfigPathLabelValue(value));
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

/** Plan step 11E4c: names of volumes as Docker takes them, at most MAX_DELETE_VOLUMES (the most additional volumes). */
function volumeNames(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_DELETE_VOLUMES || !value.every((name) => typeof name === 'string' && VOLUME_NAME.test(name))) throw invalid(what);
  return [...(value as string[])];
}

/**
 * Plan step 11E4c: the entry of a first open of a request: its ID, a repository name and a configuration path, nothing
 * else (the owner, the Docker host, the times, the names and the create mark are the extension's).
 */
export function checkedCreateRequest(value: unknown): CreateRequest {
  if (!isPlainObject(value) || !hasOnlyFields(value, CREATE_FIELDS)) throw invalid('environment');
  const { id, repository, configPath } = value;
  if (!isStorageId(id)) throw invalid('environment ID');
  if (!isRepositoryName(repository) || !plainText(repository, MAX_REPOSITORY_LENGTH)) throw invalid('repository');
  if (!isConfigPath(configPath)) throw invalid('configuration path');
  return { id, repository, configPath };
}

/**
 * Plan step 11E4c: the change of the configuration of a request (ConfigurationChange), its closed list of fields, each
 * checked and bounded, rebuilt. The volumes that the entry may not record and the bound of the service folders are
 * decided under the registry lock (requestOpenRecords).
 */
export function checkedConfigurationChange(value: unknown): ConfigurationChange {
  if (!isPlainObject(value) || !hasOnlyFields(value, CONFIGURATION_FIELDS)) throw invalid('change of the configuration');
  const { select, shutdownActionNone, addVolumes, addServiceVolumes, keepRefusedFor, serviceFolders, cloned } = value;
  if (select !== undefined && !isConfigPath(select)) throw invalid('selected configuration');
  if (shutdownActionNone !== undefined && typeof shutdownActionNone !== 'boolean') throw invalid('shutdown action');
  let keep: ConfigurationChange['keepRefusedFor'];
  if (keepRefusedFor !== undefined) {
    if (!isPlainObject(keepRefusedFor) || Object.keys(keepRefusedFor).length !== 2) throw invalid('configuration of the refused update');
    const { configPath, configHash } = keepRefusedFor;
    if (!isConfigPath(configPath) || !plainText(configHash, MAX_HASH_LENGTH)) throw invalid('configuration of the refused update');
    keep = { configPath, configHash };
  }
  let folders: ConfigurationChange['serviceFolders'];
  if (serviceFolders !== undefined) {
    if (!isPlainObject(serviceFolders) || Object.keys(serviceFolders).length !== 2 || typeof serviceFolders.overflow !== 'boolean') throw invalid('service folders');
    const list = serviceFolders.folders;
    if (!Array.isArray(list) || list.length > MAX_SERVICE_FOLDERS || !list.every((folder) => plainText(folder, MAX_SERVICE_PATH_LENGTH))) throw invalid('service folders');
    folders = { folders: [...(list as string[])], overflow: serviceFolders.overflow };
  }
  if (cloned !== undefined && cloned !== true) throw invalid('clone of the change');
  return {
    ...(select !== undefined ? { select } : {}),
    ...(shutdownActionNone !== undefined ? { shutdownActionNone } : {}),
    ...(addVolumes !== undefined ? { addVolumes: volumeNames(addVolumes, 'additional volumes') } : {}),
    ...(addServiceVolumes !== undefined ? { addServiceVolumes: volumeNames(addServiceVolumes, 'volumes of the services') } : {}),
    ...(keep !== undefined ? { keepRefusedFor: keep } : {}),
    ...(folders !== undefined ? { serviceFolders: folders } : {}),
    ...(cloned === true ? { cloned: true as const } : {}),
  };
}

/** Plan step 11E4c: a build number of a request: a whole number above zero. */
function checkedBuildNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw invalid('build number');
  return value;
}

/** Plan step 11E4c: a reference → digest map of a build record or a refused update: bounded, each digest a sha256. */
function digests(value: unknown, what: string): Record<string, string> {
  if (!isPlainObject(value)) throw invalid(what);
  const entries = Object.entries(value);
  if (entries.length > MAX_RECORD_REFERENCES) throw invalid(what);
  for (const [reference, digest] of entries) {
    if (reference === '' || reference === '__proto__' || !plainText(reference, MAX_REFERENCE_LENGTH) || typeof digest !== 'string' || !SHA256.test(digest)) throw invalid(what);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Plan step 11E4c: the names of a Compose part of a build record: bounded, none empty. */
function imageList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_RECORD_REFERENCES || !value.every((name) => plainText(name, MAX_REFERENCE_LENGTH) && name !== '')) throw invalid(what);
  return [...(value as string[])];
}

/**
 * Plan step 11E4c: the build record of a request: its closed list of fields, each checked and bounded (the image ID and
 * the digests sha256, a configuration path, the lists of its Compose part), rebuilt, and valid as the registry reads it
 * (isBuildRecord). Whether it is a record of the environment (its image name and build number, the images of its Compose
 * project: buildRecordFits) is decided under the registry lock (requestOpenRecords).
 */
export function checkedBuildRecord(value: unknown): BuildRecord {
  if (!isPlainObject(value) || !hasOnlyFields(value, BUILD_RECORD_FIELDS)) throw invalid('build record');
  const { builtAt, environmentImage, imageId, buildNumber, configPath, configHash, images, features, compose } = value;
  if (!isTime(builtAt) || !plainText(environmentImage, MAX_REFERENCE_LENGTH) || environmentImage === '') throw invalid('build record');
  if (imageId !== undefined && (typeof imageId !== 'string' || !SHA256.test(imageId))) throw invalid('image ID of the build record');
  if (!isConfigPath(configPath) || !plainText(configHash, MAX_HASH_LENGTH)) throw invalid('configuration of the build record');
  let composeRecord: ComposeBuildRecord | undefined;
  if (compose !== undefined) {
    if (!isPlainObject(compose) || !hasOnlyFields(compose, COMPOSE_RECORD_FIELDS)) throw invalid('Docker Compose part of the build record');
    const { service, version, inputsHash } = compose;
    if (!plainText(service, MAX_REFERENCE_LENGTH) || service === '' || !plainText(version, MAX_HASH_LENGTH) || !plainText(inputsHash, MAX_HASH_LENGTH)) {
      throw invalid('Docker Compose part of the build record');
    }
    composeRecord = { service, images: imageList(compose.images, 'Compose images'), serviceImages: imageList(compose.serviceImages, 'Compose service images'), version, inputsHash };
  }
  const record: BuildRecord = {
    builtAt,
    environmentImage,
    ...(imageId !== undefined ? { imageId } : {}),
    buildNumber: checkedBuildNumber(buildNumber),
    configPath,
    configHash,
    images: digests(images, 'images of the build record'),
    features: digests(features, 'features of the build record'),
    ...(composeRecord !== undefined ? { compose: composeRecord } : {}),
  };
  if (!isBuildRecord(record)) throw invalid('build record');
  return record;
}

/**
 * Plan step 11E4c: the refused update of a request (RefusedUpdate), its closed list of fields, as the pipeline records it
 * (its items at most MAX_REFUSED_ITEMS_LENGTH characters and the `…` of their middle), rebuilt.
 */
export function checkedRefusedUpdate(value: unknown): RefusedUpdate {
  if (!isPlainObject(value) || !hasOnlyFields(value, REFUSED_FIELDS)) throw invalid('refused update');
  const { configPath, configHash, images, features, items, hostAccessChecks, reason } = value;
  if (!isConfigPath(configPath) || !plainText(configHash, MAX_HASH_LENGTH)) throw invalid('configuration of the refused update');
  if (typeof items !== 'string' || items.length > MAX_REFUSED_ITEMS_LENGTH + 1) throw invalid('items of the refused update');
  if ((hostAccessChecks !== undefined && hostAccessChecks !== 'off') || (reason !== undefined && reason !== 'size')) throw invalid('refused update');
  return {
    configPath,
    configHash,
    images: digests(images, 'images of the refused update'),
    features: digests(features, 'features of the refused update'),
    items,
    ...(hostAccessChecks === 'off' ? { hostAccessChecks: 'off' as const } : {}),
    ...(reason === 'size' ? { reason: 'size' as const } : {}),
  };
}

/**
 * Plan step 11E4c: the build change of a request (BuildChange), from its kind and the arguments after it: `number` (a
 * build number), `record` (a build record and whether the refused update goes), `rebaseline` (the image name, the model
 * hash and the version of the Compose plugin), `refused` (the refused update); exactly those arguments.
 */
export function checkedBuildChange(kind: string, values: readonly unknown[]): BuildChange {
  const count = (n: number) => {
    if (values.length !== n) throw new HelperOperationError('invalid', 'The arguments of the request are invalid.', false);
  };
  switch (kind) {
    case 'number':
      count(1);
      return { kind, buildNumber: checkedBuildNumber(values[0]) };
    case 'record':
      count(2);
      if (typeof values[1] !== 'boolean') throw invalid('build record');
      return { kind, record: checkedBuildRecord(values[0]), dropRefused: values[1] };
    case 'rebaseline': {
      count(3);
      const [environmentImage, configHash, version] = values;
      if (!plainText(environmentImage, MAX_REFERENCE_LENGTH) || environmentImage === '' || !plainText(configHash, MAX_HASH_LENGTH) || !plainText(version, MAX_HASH_LENGTH)) {
        throw invalid('rebaseline of the build record');
      }
      return { kind, environmentImage, configHash, version };
    }
    case 'refused':
      count(1);
      return { kind, refusedUpdate: checkedRefusedUpdate(values[0]) };
    default:
      throw invalid('build change');
  }
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
  /**
   * Plan step 11E4c: OpenRecords.createEnvironment, the entry built here (this window's account, Docker host, clock and
   * create mark). The answer is the new entry, or the entry of the repository of the account on the Docker host that
   * another window created meanwhile (one environment per repository and account, concept D-3).
   */
  createEnvironment(request: CreateRequest): Promise<Environment>;
  /** Plan step 11E4c: OpenRecords.dropCreated, only an entry with the create mark of this window. */
  dropCreated(environmentId: string): Promise<void>;
  /** Plan step 11E4c: OpenRecords.configuration; a volume that the entry may not record is left out and logged. */
  configuration(environmentId: string, change: ConfigurationChange): Promise<Environment | undefined>;
  /** Plan step 11E4c: OpenRecords.build, only a build record of the environment (its image name and build number). */
  build(environmentId: string, change: BuildChange): Promise<Environment | undefined>;
}

/**
 * Plan step 11E4c: the volumes of `names` that `entry` may record as additional volumes. Left out, with a log line (as the
 * restore leaves out an entry that does not fit): the workspace volume of the entry or of another entry, an additional
 * volume of an entry of another account, and a volume that a Delete of another account kept. An additional volume of
 * another entry of the same account stays: the environments of one account share it (recordedVolumes,
 * isSameOwnerAdditionalVolume), and its record keeps the Delete of the other entry from removing it.
 */
function admittedVolumes(names: readonly string[], entry: Environment, file: RegistryFile, logger: BusyMarkView['logger']): string[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const others = file.environments.filter((other) => other.id !== entry.id);
  return names.filter((name) => {
    let why: string | undefined;
    if (same(name, entry.volumeName)) why = 'it is the workspace volume of the environment';
    else if (others.some((other) => same(other.volumeName, name))) why = 'it is the workspace volume of another environment';
    else if (others.some((other) => other.owner.id !== entry.owner.id && (other.additionalVolumes ?? []).some((volume) => same(volume, name)))) why = 'an environment of another account uses it';
    else if ((file.keptVolumes ?? []).some((record) => record.owner.id !== entry.owner.id && same(record.name, name))) why = 'a Delete of another account kept it';
    // The name is a volume name (checkedConfigurationChange), never other text of the worker.
    if (why !== undefined) logger.warn(`The worker recorded the volume ${name} for ${entry.repository}, which is left out: ${why}.`);
    return why === undefined;
  });
}

/**
 * The writes of the open for the requests of the worker, over the registry of this computer: the rules of
 * registryOpenRecords with this window's owner, clock and liveness (`view`), each only on an entry of `account` on
 * `dockerHost`, checked under the registry lock (an entry that does not fit is refused, nothing is written). A missing
 * entry is `undefined`, as in OpenRecords.
 */
export function requestOpenRecords(
  registry: Pick<EnvironmentRegistry, 'updateEnvironment' | 'update'>,
  view: BusyMarkView,
  scope: { account: GitHubAccount; dockerHost: string },
): OpenRequests {
  const isOwnMark = (mark: BusyMark) => mark.windowId === view.owner.windowId && mark.pid === view.owner.pid;
  // The check of every request under the lock: an entry of the signed-in account on the operation's Docker host.
  const checkEntry = (entry: Environment) => {
    if (entry.owner.id !== scope.account.id) {
      throw new HelperOperationError('invalid', 'The environment of the request belongs to another account than the one signed in.', false);
    }
    if (!isOnDockerHost(entry, scope.dockerHost)) {
      throw new HelperOperationError('invalid', 'The environment of the request is on another Docker host than the one of the operation.', false);
    }
  };
  // Plan step 11E4c: an entry is added and removed only by createEnvironment and dropCreated below, with their own checks.
  const noEntries = {
    add: async () => {
      throw new Error('A request of the open adds an entry only as its first open (createEnvironment).');
    },
    remove: async () => {
      throw new Error('A request of the open removes only the entry that it created (dropCreated).');
    },
  };
  // The checks of every request under the lock, before the rule of registryOpenRecords; `also` adds the check of one.
  const records = (also?: (entry: Environment) => void): OpenRecords =>
    registryOpenRecords(
      {
        ...noEntries,
        updateEnvironment: (id, mutator) =>
          registry.updateEnvironment(id, async (entry) => {
            checkEntry(entry);
            also?.(entry);
            await mutator(entry);
          }),
      },
      view,
    );
  // Plan step 11E4c: the same over the whole registry file of the lock (`also` sees the other entries and the kept volumes).
  const recordsIn = (file: RegistryFile, also: (entry: Environment) => void): OpenRecords =>
    registryOpenRecords(
      {
        ...noEntries,
        updateEnvironment: async (id, mutator) => {
          const entry = file.environments.find((candidate) => candidate.id === id);
          if (!entry) return undefined;
          checkEntry(entry);
          also(entry);
          await mutator(entry);
          return entry;
        },
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
    createEnvironment: async ({ id, repository, configPath }) => {
      const now = isoTime(view.clock);
      const name = resourceName(repository, id);
      // As openFirst builds it, with this window's clock, create mark, account and the operation's Docker host.
      const environment: Environment = {
        id,
        repository,
        configPath,
        volumeName: name,
        containerName: name,
        createdAt: now,
        lastUsedAt: now,
        busy: { operation: 'create', since: now, pid: view.owner.pid, windowId: view.owner.windowId },
        owner: ownerOf(scope.account),
        ...dockerHostField(scope.dockerHost),
      };
      return registry.update((file) => {
        // One environment per repository and account on a Docker host (concept D-3): the one that another window created
        // meanwhile is the answer, and the open uses it (as openFirst does).
        const existing = file.environments.find((entry) => isEnvironmentOf(entry, repository, scope.account.id, scope.dockerHost));
        if (existing) return existing;
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        if (file.environments.some((entry) => entry.id === id || same(entry.volumeName, name) || same(entry.containerName, name))) {
          throw new HelperOperationError('invalid', 'The registry has an environment of the ID or the volume of the request already.', false);
        }
        file.environments.push(environment);
        return environment;
      });
    },
    dropCreated: (environmentId) =>
      registry.update((file) => {
        const entry = file.environments.find((candidate) => candidate.id === environmentId);
        // A missing entry is no error (as EnvironmentRegistry.remove).
        if (!entry) return;
        checkEntry(entry);
        if (!entry.busy || !isOwnMark(entry.busy) || entry.busy.operation !== 'create') {
          throw new HelperOperationError('invalid', 'The environment of the request does not carry the create mark of this window.', false);
        }
        file.environments = file.environments.filter((candidate) => candidate.id !== environmentId);
      }),
    configuration: (environmentId, change) => {
      // The mutator of registryOpenRecords reads the change when it runs, after `also` has left out what does not fit.
      const admitted: ConfigurationChange = { ...change };
      return registry.update((file) =>
        recordsIn(file, (entry) => {
          if (change.addVolumes !== undefined) admitted.addVolumes = admittedVolumes(change.addVolumes, entry, file, view.logger);
          if (change.addServiceVolumes !== undefined) {
            // The volumes of the services are additional volumes of the entry (after this change), and no other.
            const additional = new Set([...(entry.additionalVolumes ?? []), ...(admitted.addVolumes ?? [])]);
            admitted.addServiceVolumes = change.addServiceVolumes.filter((name) => {
              if (!additional.has(name)) view.logger.warn(`The worker recorded the volume ${name} of a service for ${entry.repository}, which is left out: it is no additional volume of the environment.`);
              return additional.has(name);
            });
          }
          // As the pipeline records them (and the restore): only paths of the repository, within the bounds.
          if (change.serviceFolders !== undefined) {
            admitted.serviceFolders = boundServiceFolders(repositoryFolder(entry.repository), [change.serviceFolders.folders], change.serviceFolders.overflow);
          }
        }).configuration(environmentId, admitted),
      );
    },
    build: (environmentId, change) =>
      records((entry) => {
        if (change.kind === 'record') {
          const { buildNumber } = change.record;
          if (!buildRecordFits(change.record, entry, environmentImageName(entry.repository, entry.id, buildNumber), buildNumber)) {
            throw new HelperOperationError('invalid', 'The build record of the request is not one of an image of the environment.', false);
          }
        }
        // A rebaseline of another image than the one of the build record changes nothing (registryOpenRecords), as in the
        // extension's own open: another window's rebuild may have won the race; the image name is only compared.
      }).build(environmentId, change),
  };
}
