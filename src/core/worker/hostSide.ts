// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B (decision of 2026-10-03, the worker is the deputy): what a flow in the worker needs from the user's
// computer, as one interface per kind of request of plan step 11A (`question`, `local`, `record`, `secret`, `connect`).
// The worker's side of them (workerHostSide) sends the requests; the extension's side (hostSideHandler, src/vscode)
// answers them. Pure types, the check of a request, and the requests of each flow; no I/O, no `vscode`.
import { OP_DELETE, OP_DELETE_CHECK, OP_HEARTBEAT, OP_LIST_CONFIGURATIONS, OP_MONITOR_ENSURE, OP_MONITOR_SETTINGS, OP_RECONCILE, OP_RECORD_GIT_STATE, OP_STOP, OP_TOKEN_REMOVE, OP_WINDOW_STATE, SECRET_REGISTRY, SECRET_TOKEN, type AskKind } from '../helperChannel/protocol';
import type { BusyMarkResult } from '../pipeline/busyMarks';
import type { BusyMark, BusyOperation, Environment, GitHubAccount, GitSummary, RegistryFile, WindowStatus } from '../types';
import type { DeleteConfirmation } from '../pipeline/deleteCheck';
import type { GitHubViewer } from '../helper/containerGit';
import type { BuildChange, ConfigurationChange, LifecycleMarkChange, StepMarkResult } from '../pipeline/openRecords';
import type { HostOpenFinish, OpenRequestScope } from './openRequests';

/** The questions of a flow to the user (PipelineUi without the messages, which go as log lines and progress). */
export interface HostQuestions {
  confirmUntrustedRepository(repository: string): Promise<boolean>;
  configurationChanged(repository: string): Promise<'rebuildNow' | 'later'>;
  configurationKindChanged(repository: string, message: string): Promise<'rebuildNow' | 'later'>;
  filesMissing(repository: string): Promise<'cloneAgain' | 'deleteEnvironment' | undefined>;
  recreateContainer(repository: string, question: { message: string; detail: string }): Promise<boolean>;
  /** Plan step 11C2b: the questions of Delete (PipelineUi), with their facts; `undefined`: cancel. */
  confirmDelete(repository: string, confirmation: DeleteConfirmation): Promise<'delete' | 'open' | undefined>;
  deleteAdditionalVolumes(volumes: readonly string[]): Promise<'remove' | 'keep' | undefined>;
  deleteServiceData(volumes: readonly string[], possibly: readonly string[]): Promise<string[] | undefined>;
  /** A message without a question: info, warn, or the sign-in hint of a registry. */
  message(kind: 'info' | 'warn' | 'registrySignIn', text: string): Promise<void>;
}

/** The state on the user's computer that a flow reads (the window files, the busy marks, the remembered answers). */
export interface HostState {
  /** The windows of this computer with their status (SessionFiles.readWindowStatuses). */
  windowStatuses(): Promise<readonly WindowStatus[]>;
  /** The pending files of this computer (SessionFiles.readPendings). */
  pendings(): Promise<readonly { environmentId: string; windowId: string; createdAt: string }[]>;
  /** The settings of the extension that a flow reads (ExtensionSettings as JSON). */
  settings(): Promise<Record<string, unknown>>;
  /** True while the process `pid` of this computer runs. */
  processAlive(pid: number): Promise<boolean>;
  /**
   * Plan step 11B3b: the signed-in GitHub account (GitHubAuth.getAccount), its id and login, never a token; `interactive`
   * lets the extension ask the user to sign in. `undefined`: no one is signed in.
   */
  account(interactive: boolean): Promise<GitHubAccount | undefined>;
  /**
   * Plan step 11E4d: the GitHub profile of the signed-in account (DiscoveryService.viewer), asked by the extension with
   * its own token, for the Git identity of a new environment. `undefined`: it could not be read.
   */
  viewer(): Promise<GitHubViewer | undefined>;
  /** Plan step 11E4d (decision of 2026-09-29): the container that the window remembers for the environment (LifecycleMemory). */
  unrecordedLifecycle(environmentId: string): Promise<string | undefined>;
}

/** The records of the user's computer that a flow changes (the registry and the session files). */
export interface HostRecords {
  read(): Promise<RegistryFile>;
  get(id: string): Promise<Environment | undefined>;
  list(): Promise<Environment[]>;
  findForAccount(repository: string, accountId: string, dockerHost: string): Promise<Environment | undefined>;
  // Plan step 11E4c: changed (the generic `add` and `update` are removed): an entry is added only as `record
  // createEnvironment`, and changed only by the specific requests below.
  remove(id: string, volumes: { kept?: readonly string[]; removed?: readonly string[] }): Promise<void>;
  forgetKeptVolumes(names: readonly string[]): Promise<void>;
  /** Plan step 11E4d: the window remembers the container of the environment whose lifecycle mark could not be recorded. */
  rememberLifecycle(environmentId: string, containerId: string): Promise<void>;
  /** Plan step 11E4d: the window forgets it, when it is that container. */
  forgetLifecycle(environmentId: string, containerId: string): Promise<void>;
  /**
   * The session files of the environment (pending, operation, reopen, disconnect request). Plan step 11C2a:
   * `removeReopenOf`, the reopen record only when it names the environment.
   */
  sessionFile(kind: HostSessionFile, environmentId: string): Promise<void>;
  /**
   * Plan step 11C2a (decision of 2026-10-04): the busy mark of the window that sent the operation, set by the extension
   * with its clock and its view of the windows, under its registry lock (registryBusyMarks). Plan step 11E4b:
   * `onReplaced` hears the mark that the new mark replaced (the extension's handler remembers it for `record createMark`
   * `previous`); the worker's side never passes it.
   */
  markBusy(environmentId: string, operation: BusyOperation, onReplaced?: (mark: BusyMark) => void): Promise<BusyMarkResult>;
  /** Plan step 11C2a: removes the busy mark of the window that sent the operation. */
  clearBusy(environmentId: string): Promise<void>;
  /**
   * Plan step 11C2b (decision of 2026-10-04): records the Git state of the environment (Environment.gitSummary), as the
   * worker read it in its running dev container.
   */
  recordGitSummary(environmentId: string, summary: GitSummary): Promise<void>;
  /**
   * Plan step 11C3 (decision of 2026-10-04): adds the entries that the worker rebuilt from the labels of the volumes of
   * its engine (EnvironmentRegistry.restore), under the registry lock, with the clock of the extension; `skipped`: the
   * volumes whose repository has an environment of the same owner already.
   */
  restore(entries: readonly Environment[]): Promise<{ added: number; skipped: string[] }>;
  /**
   * Plan step 11E4b (decision of 2026-10-04): the registry writes of the open (OpenRecords), each a request of its own
   * that the extension applies under its registry lock with its owner, clock, account and view of the windows, only on the
   * entry of the operation's environment of the signed-in account on the operation's Docker host (requestOpenRecords).
   * `scope` is what the extension's handler takes from the operation, never from the request; the worker's side never
   * passes it, and the extension refuses without it. `record createMark`: `previous` only as a mark that a `record
   * markBusy` of the same operation replaced.
   */
  createMark(environmentId: string, kind: 'ended' | 'previous', previous: BusyMark | undefined, scope?: OpenRequestScope): Promise<Environment | undefined>;
  /** Plan step 11E4b: `record stepMark` `take`; the extension builds the mark (its owner and clock). */
  takeStepMark(environmentId: string, operation: BusyOperation, scope?: OpenRequestScope): Promise<StepMarkResult>;
  /** Plan step 11E4b: `record stepMark` `release`, only a mark of the window that sent the operation. */
  releaseStepMark(environmentId: string, mark: BusyMark, scope?: OpenRequestScope): Promise<Environment | undefined>;
  /** Plan step 11E4b: `record ownerLogin`, the login of the account signed in in the extension (never the worker's). */
  ownerLogin(environmentId: string, scope?: OpenRequestScope): Promise<Environment | undefined>;
  /** Plan step 11E4b: `record lifecycleMark`. */
  lifecycleMark(environmentId: string, change: LifecycleMarkChange, scope?: OpenRequestScope): Promise<Environment | undefined>;
  /** Plan step 11E4b: `record openFinished`; the time and the liveness are the extension's. */
  openFinished(environmentId: string, finish: HostOpenFinish, scope?: OpenRequestScope): Promise<Environment | undefined>;
  /**
   * Plan step 11E4c: `record createEnvironment`, the entry of a first open: the worker picks its ID and names the
   * repository and the configuration; the extension builds the rest (its account, clock and create mark, the Docker host
   * of the operation) and binds the operation to the environment. The answer is the new entry, or the one of the
   * repository that another window of the account created meanwhile.
   */
  createEnvironment(id: string, repository: string, configPath: string, scope?: OpenRequestScope): Promise<Environment>;
  /** Plan step 11E4c: `record dropCreated`, only the entry that the operation created, with the create mark of the window. */
  dropCreated(environmentId: string, scope?: OpenRequestScope): Promise<void>;
  /** Plan step 11E4c: `record configuration`; a volume that the entry may not record is left out (and logged). */
  configuration(environmentId: string, change: ConfigurationChange, scope?: OpenRequestScope): Promise<Environment | undefined>;
  /** Plan step 11E4c: `record build` (`number`, `record`, `rebaseline`, `refused`). */
  build(environmentId: string, change: BuildChange, scope?: OpenRequestScope): Promise<Environment | undefined>;
}

/** The session files that a flow writes or removes (HostRecords.sessionFile). */
export const HOST_SESSION_FILES = ['writePending', 'removePending', 'removeOperation', 'removeReopen', 'removeReopenOf', 'removeDisconnectRequest'] as const;
export type HostSessionFile = (typeof HOST_SESSION_FILES)[number];

/** The secrets that only the user's computer has. `undefined`: there is none (an anonymous pull, no sign-in). */
export interface HostSecrets {
  /** The GitHub token of the signed-in account (SECRET_TOKEN). */
  token(): Promise<string | undefined>;
  /**
   * The login of a registry: the GitHub sign-in for ghcr.io, else what Docker stored on this computer. The password (or
   * the identity token) travels as the secret SECRET_REGISTRY, never in the value of the answer.
   */
  registry(registry: string): Promise<{ username?: string; identityToken?: boolean; serveraddress: string; password: string } | undefined>;
}

/** What the window needs to connect at the end of an open (the extension connects it through the Dev Containers extension). */
export interface HostConnect {
  connect(data: { environmentId: string; container: string; user?: string; folder: string }): Promise<void>;
}

/** Everything that a flow in the worker needs from the user's computer. */
export interface HostSide {
  questions: HostQuestions;
  state: HostState;
  records: HostRecords;
  secrets: HostSecrets;
  connect: HostConnect;
}

/**
 * The payload of a request: its kind (plan step 11A) and the call, so that one handler on the extension's side answers
 * every request of a flow. `args` are the arguments of the call, as JSON.
 */
export interface HostRequest {
  kind: AskKind;
  call: string;
  args: unknown[];
}

/** The strict check of a request (the extension's side). */
export function parseHostRequest(value: unknown, kind: AskKind): HostRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { call, args } = value as { call?: unknown; args?: unknown };
  if (typeof call !== 'string' || !/^[a-z][a-zA-Z0-9]{0,63}$/.test(call)) return undefined;
  if (!Array.isArray(args)) return undefined;
  return { kind, call, args: [...(args as unknown[])] };
}

/** The names of the secrets that a flow asks for (plan step 11A). */
export const HOST_SECRET_NAMES = { token: SECRET_TOKEN, registry: SECRET_REGISTRY } as const;

/** The answer of a `secret` request: what the operation needs beside the secret, which travels in `secrets`. */
export interface HostSecretAnswer {
  /** False when the user's computer has no such secret (the operation goes on without it). */
  given: boolean;
  /** For a registry login: its user and server; an identity token has no user. */
  username?: string;
  identityToken?: boolean;
  serveraddress?: string;
}

/** A request as `<kind> <call>`, for example `record get`. */
export type HostCall = `${AskKind} ${string}`;

/**
 * Review round 1 of plan step 11B1 (A-R1-8): the requests that each flow may send. The extension answers only these for
 * an operation, so a flow gets no secret, and changes no record, that it has no business with; an operation that is not
 * listed may send none. Each flow adds its requests here when it moves into the worker.
 */
export const FLOW_REQUESTS: Readonly<Record<string, readonly HostCall[]>> = {
  [OP_TOKEN_REMOVE]: ['record get'],
  // Plan step 11B2: Stop needs nothing from this computer (its parameters carry what it needs; the extension records the Git state).
  [OP_STOP]: [],
  // Plan step 11B3b: the listing of Select configuration reads the record and the account; no secret, no write.
  [OP_LIST_CONFIGURATIONS]: ['record get', 'local account'],
  // Plan step 11C1: the reads of an attached window need nothing from this computer.
  [OP_WINDOW_STATE]: [],
  // Plan step 11C2a: Delete reads the record, the registry (the volumes that other environments use or keep: review round
  // 1 of 11C2a, A-R1-H1) and the account, marks the environment busy for `delete` only and clears the mark, removes the
  // entry and the session files of the environment (each tied to the environment of the operation: SCOPED_REQUESTS;
  // review round 1, A-R1-L1, A-R1-L4: only these kinds); no secret, no other write.
  [OP_DELETE]: [
    'record get',
    'record list',
    'record read',
    'local account',
    'record markBusy.delete',
    'record clearBusy',
    'record remove',
    'record sessionFile.removePending',
    'record sessionFile.removeOperation',
    'record sessionFile.removeDisconnectRequest',
    'record sessionFile.removeReopenOf',
  ],
  // Plan step 11C2b: the check of Delete reads the record, the registry (the volumes of the other environments) and the
  // account, records the Git state of its environment (SCOPED_REQUESTS), and asks the questions of Delete; no secret.
  [OP_DELETE_CHECK]: [
    'record get',
    'record read',
    'local account',
    'record recordGitSummary',
    'question confirmDelete',
    'question deleteAdditionalVolumes',
    'question deleteServiceData',
  ],
  // Plan step 11C3: the rebuild of the registry adds the entries of the volumes of its engine, and nothing else; it reads
  // no record (the registry adds only what it lacks).
  [OP_RECONCILE]: ['record restore'],
  // Plan step 11D1: the commands of the Session Monitor need nothing from this computer (their parameters carry them).
  [OP_HEARTBEAT]: [],
  [OP_MONITOR_SETTINGS]: [],
  // Plan step 11D2: the ensure of the monitor needs nothing from this computer either.
  [OP_MONITOR_ENSURE]: [],
  // Plan step 11D1: the Git state of a release reads the record and records the state of its environment (SCOPED_REQUESTS).
  [OP_RECORD_GIT_STATE]: ['record get', 'record recordGitSummary'],
};

/**
 * Review round 1 of 11C2a (A-R1-L1, A-R1-L4): the requests whose allowance can name one kind (`<kind> <call>.<detail>`
 * in FLOW_REQUESTS), and the index of that kind in their arguments: the session file, the busy operation. The bare
 * `<kind> <call>` allows every kind.
 */
export const DETAILED_REQUESTS: Readonly<Partial<Record<HostCall, number>>> = {
  'record sessionFile': 0,
  'record markBusy': 1,
  // Plan step 11E4b: the kind of the create mark (`ended`, `previous`) and of the step mark (`take`, `release`).
  'record createMark': 1,
  'record stepMark': 1,
  // Plan step 11E4c: the kind of the build change (`number`, `record`, `rebaseline`, `refused`).
  'record build': 1,
};

/**
 * Plan step 11C2a (review round 2 of 11B1, A-R2-2): the requests that change the record or the session files of one
 * environment, and the index of its id in their arguments. The extension answers them only for the environment of the
 * operation (`environmentId` of its parameters; plan step 11E4c: or the one that its `record createEnvironment` created).
 */
export const SCOPED_REQUESTS: Readonly<Partial<Record<HostCall, number>>> = {
  'record markBusy': 0,
  'record clearBusy': 0,
  'record remove': 0,
  'record sessionFile': 1,
  'record recordGitSummary': 0,
  // Plan step 11E4b: the registry writes of the open (OpenRecords); no operation sends them before plan step 11E6.
  'record createMark': 0,
  'record stepMark': 0,
  'record ownerLogin': 0,
  'record lifecycleMark': 0,
  'record openFinished': 0,
  // Plan step 11E4c: `record createEnvironment` names no environment of the operation yet: it binds the operation to the
  // one that it creates (hostSideHandler), and these are answered only for it.
  'record dropCreated': 0,
  'record configuration': 0,
  'record build': 0,
  // Plan step 11E4d: the window's memory of the environment's container whose lifecycle mark could not be recorded.
  'local unrecordedLifecycle': 0,
  'record rememberLifecycle': 0,
  'record forgetLifecycle': 0,
};
