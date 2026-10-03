// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B (decision of 2026-10-03, the worker is the deputy): what a flow in the worker needs from the user's
// computer, as one interface per kind of request of plan step 11A (`question`, `local`, `record`, `secret`, `connect`).
// The worker's side of them (workerHostSide) sends the requests; the extension's side (hostSideHandler, src/vscode)
// answers them. Pure types, the check of a request, and the requests of each flow; no I/O, no `vscode`.
import { OP_STOP, OP_TOKEN_REMOVE, SECRET_REGISTRY, SECRET_TOKEN, type AskKind } from '../helperChannel/protocol';
import type { Environment, RegistryFile, WindowStatus } from '../types';

/** The questions of a flow to the user (PipelineUi without the messages, which go as log lines and progress). */
export interface HostQuestions {
  confirmUntrustedRepository(repository: string): Promise<boolean>;
  configurationChanged(repository: string): Promise<'rebuildNow' | 'later'>;
  configurationKindChanged(repository: string, message: string): Promise<'rebuildNow' | 'later'>;
  filesMissing(repository: string): Promise<'cloneAgain' | 'deleteEnvironment' | undefined>;
  recreateContainer(repository: string, question: { message: string; detail: string }): Promise<boolean>;
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
}

/** The records of the user's computer that a flow changes (the registry and the session files). */
export interface HostRecords {
  read(): Promise<RegistryFile>;
  get(id: string): Promise<Environment | undefined>;
  list(): Promise<Environment[]>;
  findForAccount(repository: string, accountId: string, dockerHost: string): Promise<Environment | undefined>;
  add(environment: Environment): Promise<void>;
  update(id: string, changes: Partial<Environment>): Promise<void>;
  remove(id: string, volumes: { kept?: readonly string[]; removed?: readonly string[] }): Promise<void>;
  forgetKeptVolumes(names: readonly string[]): Promise<void>;
  /** The session files of the environment (pending, operation, reopen, disconnect request). */
  sessionFile(kind: 'writePending' | 'removePending' | 'removeOperation' | 'removeReopen' | 'removeDisconnectRequest', environmentId: string): Promise<void>;
}

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
};
