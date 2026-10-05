// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B (decision of 2026-10-03, the worker is the deputy): the HostSide of a flow that runs in the worker. Every
// call becomes a request of its kind to the extension (plan step 11A, `OperationContext.ask`), which answers it. Pure
// over `ask`; no I/O of its own, no `vscode`.
import { BUSY_OPERATIONS, type BusyMarkResult } from '../pipeline/busyMarks';
import type { BuildChange, StepMarkResult } from '../pipeline/openRecords';
import type { BusyMark, Environment, GitHubAccount, RegistryFile, WindowStatus } from '../types';
import { HOST_SECRET_NAMES, type HostRequest, type HostSide } from './hostSide';
import { isGitHubLogin, type GitHubViewer } from '../helper/containerGit';

/**
 * Plan step 11C2a: the answer of `record markBusy` as the pipeline uses it: the entry of `environmentId`, or a busy mark
 * that keeps it, or undefined (no entry). Anything else is a failure of the request (never taken as "not busy").
 */
/**
 * Plan step 11C3: the answer of `record restore`: the number of added entries and the volumes left out. Anything else is
 * a failure of the request.
 */
export function parseRestoreAnswer(value: unknown): { added: number; skipped: string[] } {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const { added, skipped } = value as { added?: unknown; skipped?: unknown };
    if (typeof added === 'number' && Number.isSafeInteger(added) && added >= 0 && Array.isArray(skipped) && skipped.every((name) => typeof name === 'string')) {
      return { added, skipped: [...(skipped as string[])] };
    }
  }
  throw new Error('The extension answered the restore of the registry with an invalid value.');
}

export function parseBusyMarkAnswer(value: unknown, environmentId: string): BusyMarkResult {
  if (value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const { environment, conflict } = value as { environment?: unknown; conflict?: unknown };
    if (environment !== undefined && conflict === undefined && typeof environment === 'object' && environment !== null && (environment as { id?: unknown }).id === environmentId) {
      return { environment: environment as Environment };
    }
    if (conflict !== undefined && environment === undefined && isBusyMark(conflict)) return { conflict };
  }
  throw new Error('The extension answered the busy mark with an invalid value.');
}

/**
 * Plan step 11E4b: the answer of a registry write of the open (`record createMark`, `record stepMark` `release`, `record
 * ownerLogin`, `record lifecycleMark`, `record openFinished`; plan step 11E4c: `record configuration`, `record build`):
 * the entry of `environmentId`, or undefined (no entry).
 * Anything else is a failure of the request.
 */
export function parseEntryAnswer(value: unknown, environmentId: string): Environment | undefined {
  if (value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value) && (value as { id?: unknown }).id === environmentId) return value as Environment;
  throw new Error('The extension answered the registry write with an invalid value.');
}

/**
 * Plan step 11E4b: the answer of `record stepMark` `take` (OpenRecords.takeStepMark): the entry of `environmentId` with
 * the mark that was set or the mark that keeps it, or undefined (no entry). Anything else is a failure of the request
 * (never taken as a mark of this window).
 */
export function parseStepMarkAnswer(value: unknown, environmentId: string): StepMarkResult {
  if (value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const { environment, mark, conflict } = value as { environment?: unknown; mark?: unknown; conflict?: unknown };
    if (typeof environment === 'object' && environment !== null && !Array.isArray(environment) && (environment as { id?: unknown }).id === environmentId) {
      if (mark !== undefined && conflict === undefined && isBusyMark(mark)) return { environment: environment as Environment, mark };
      if (conflict !== undefined && mark === undefined && isBusyMark(conflict)) return { environment: environment as Environment, conflict };
    }
  }
  throw new Error('The extension answered the step mark with an invalid value.');
}

/**
 * Plan step 11E4d: the answer of `local viewer`: a GitHub profile (its database ID, a login, a name of at most 255
 * characters or none), or `undefined` when the extension could not read it. Anything else is an error (identityOf then
 * uses the account of the session).
 */
export function parseViewerAnswer(value: unknown): GitHubViewer | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('The extension answered the GitHub profile with an invalid value.');
  const { databaseId, login, name } = value as Record<string, unknown>;
  const id = typeof databaseId === 'number' ? Number.isSafeInteger(databaseId) && databaseId > 0 : typeof databaseId === 'string' && /^[1-9][0-9]{0,19}$/.test(databaseId);
  if (!id || typeof login !== 'string' || !isGitHubLogin(login) || (name !== null && name !== undefined && (typeof name !== 'string' || name.length > 255))) {
    throw new Error('The extension answered the GitHub profile with an invalid value.');
  }
  return { databaseId: databaseId as number | string, login, name: (name as string | null | undefined) ?? null };
}

/**
 * Plan step 11E4c: the answer of `record createEnvironment`: the entry of the repository `repository` (the new one, or
 * the one that another window of the account created meanwhile). Anything else is a failure of the request.
 */
export function parseCreatedAnswer(value: unknown, repository: string): Environment {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const { id, repository: named } = value as { id?: unknown; repository?: unknown };
    if (typeof id === 'string' && id !== '' && typeof named === 'string' && named.toLowerCase() === repository.toLowerCase()) return value as Environment;
  }
  throw new Error('The extension answered the entry of the first open with an invalid value.');
}

/** Plan step 11E4c: the arguments of `record build` after the environment: the kind of the change and its values. */
export function buildArguments(change: BuildChange): unknown[] {
  switch (change.kind) {
    case 'number':
      return ['number', change.buildNumber];
    case 'record':
      return ['record', change.record, change.dropRefused];
    case 'rebaseline':
      return ['rebaseline', change.environmentImage, change.configHash, change.version];
    case 'refused':
      return ['refused', change.refusedUpdate];
  }
}

function isBusyMark(value: unknown): value is BusyMark {
  if (typeof value !== 'object' || value === null) return false;
  const { operation, since, pid, windowId } = value as Record<string, unknown>;
  return (
    (BUSY_OPERATIONS as readonly unknown[]).includes(operation) &&
    typeof since === 'string' &&
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    typeof windowId === 'string'
  );
}

/** What the worker's operation context gives this module: one request to the extension, which resolves with its value. */
export type AskHost = (request: HostRequest) => Promise<unknown>;

/** The secret of the last `secret` request, as the operation holds it after the answer (OperationContext.secrets). */
export type SecretOf = (name: string) => string | undefined;

/**
 * The HostSide of a flow in the worker: every call is one request to the extension. The answers are the values of the
 * calls; a failure of the extension (its code) comes back as the rejection of the call.
 */
export function workerHostSide(ask: AskHost, secretOf: SecretOf): HostSide {
  const call = async (kind: HostRequest['kind'], name: string, ...args: unknown[]): Promise<unknown> => ask({ kind, call: name, args });
  return {
    questions: {
      confirmUntrustedRepository: async (repository) => (await call('question', 'confirmUntrustedRepository', repository)) === true,
      configurationChanged: async (repository) => ((await call('question', 'configurationChanged', repository)) === 'rebuildNow' ? 'rebuildNow' : 'later'),
      configurationKindChanged: async (repository, message) =>
        (await call('question', 'configurationKindChanged', repository, message)) === 'rebuildNow' ? 'rebuildNow' : 'later',
      filesMissing: async (repository) => {
        const answer = await call('question', 'filesMissing', repository);
        return answer === 'cloneAgain' || answer === 'deleteEnvironment' ? answer : undefined;
      },
      recreateContainer: async (repository, question) => (await call('question', 'recreateContainer', repository, question)) === true,
      // Plan step 11C2b: the questions of Delete; anything but a known answer is cancel.
      confirmDelete: async (repository, confirmation) => {
        const answer = await call('question', 'confirmDelete', repository, confirmation);
        return answer === 'delete' || answer === 'open' ? answer : undefined;
      },
      deleteAdditionalVolumes: async (volumes) => {
        const answer = await call('question', 'deleteAdditionalVolumes', [...volumes]);
        return answer === 'remove' || answer === 'keep' ? answer : undefined;
      },
      deleteServiceData: async (volumes, possibly) => {
        const answer = await call('question', 'deleteServiceData', [...volumes], [...possibly]);
        return Array.isArray(answer) && answer.every((name) => typeof name === 'string' && volumes.includes(name)) ? (answer as string[]) : undefined;
      },
      message: async (kind, text) => void (await call('question', 'message', kind, text)),
    },
    state: {
      windowStatuses: async () => ((await call('local', 'windowStatuses')) ?? []) as readonly WindowStatus[],
      pendings: async () => ((await call('local', 'pendings')) ?? []) as readonly { environmentId: string; windowId: string; createdAt: string }[],
      settings: async () => ((await call('local', 'settings')) ?? {}) as Record<string, unknown>,
      // Plan step 11E4d: only `false` is an ended process; anything else counts as running (when in doubt, in use).
      processAlive: async (pid) => (await call('local', 'processAlive', pid)) !== false,
      viewer: async () => parseViewerAnswer(await call('local', 'viewer')),
      unrecordedLifecycle: async (environmentId) => {
        const answer = await call('local', 'unrecordedLifecycle', environmentId);
        if (answer === null) return undefined;
        if (typeof answer !== 'string' || !/^[0-9a-f]{12,64}$/.test(answer)) throw new Error('The extension answered the remembered container with an invalid value.');
        return answer;
      },
      account: async (interactive) => {
        const answer = (await call('local', 'account', interactive)) as { id?: unknown; login?: unknown } | null;
        // Plan step 11B3b: only an account with its id; anything else counts as no one signed in.
        if (answer === null || typeof answer !== 'object' || typeof answer.id !== 'string' || answer.id === '') return undefined;
        return { id: answer.id, login: typeof answer.login === 'string' ? answer.login : '' } satisfies GitHubAccount;
      },
    },
    records: {
      read: async () => (await call('record', 'read')) as RegistryFile,
      get: async (id) => ((await call('record', 'get', id)) ?? undefined) as Environment | undefined,
      list: async () => ((await call('record', 'list')) ?? []) as Environment[],
      findForAccount: async (repository, accountId, dockerHost) =>
        ((await call('record', 'findForAccount', repository, accountId, dockerHost)) ?? undefined) as Environment | undefined,
      remove: async (id, volumes) => void (await call('record', 'remove', id, volumes)),
      forgetKeptVolumes: async (names) => void (await call('record', 'forgetKeptVolumes', [...names])),
      // Plan step 11E4d: the window's memory of the container whose lifecycle mark could not be recorded.
      rememberLifecycle: async (environmentId, containerId) => void (await call('record', 'rememberLifecycle', environmentId, containerId)),
      forgetLifecycle: async (environmentId, containerId) => void (await call('record', 'forgetLifecycle', environmentId, containerId)),
      sessionFile: async (kind, environmentId) => void (await call('record', 'sessionFile', kind, environmentId)),
      markBusy: async (environmentId, operation) => parseBusyMarkAnswer(await call('record', 'markBusy', environmentId, operation), environmentId),
      clearBusy: async (environmentId) => void (await call('record', 'clearBusy', environmentId)),
      recordGitSummary: async (environmentId, summary) => void (await call('record', 'recordGitSummary', environmentId, summary)),
      restore: async (entries) => parseRestoreAnswer(await call('record', 'restore', entries)),
      // Plan step 11E4b (decision of 2026-10-04): the registry writes of the open; the scope is the extension's (never sent).
      createMark: async (environmentId, kind, previous) =>
        parseEntryAnswer(
          kind === 'previous' && previous !== undefined ? await call('record', 'createMark', environmentId, kind, previous) : await call('record', 'createMark', environmentId, kind),
          environmentId,
        ),
      takeStepMark: async (environmentId, operation) => parseStepMarkAnswer(await call('record', 'stepMark', environmentId, 'take', operation), environmentId),
      releaseStepMark: async (environmentId, mark) => parseEntryAnswer(await call('record', 'stepMark', environmentId, 'release', mark), environmentId),
      ownerLogin: async (environmentId) => parseEntryAnswer(await call('record', 'ownerLogin', environmentId), environmentId),
      lifecycleMark: async (environmentId, change) => parseEntryAnswer(await call('record', 'lifecycleMark', environmentId, change), environmentId),
      openFinished: async (environmentId, finish) => parseEntryAnswer(await call('record', 'openFinished', environmentId, finish), environmentId),
      // Plan step 11E4c: the entry of a first open (its ID, repository and configuration only), its removal, the
      // configuration and the build records.
      createEnvironment: async (id, repository, configPath) => parseCreatedAnswer(await call('record', 'createEnvironment', { id, repository, configPath }), repository),
      dropCreated: async (environmentId) => void (await call('record', 'dropCreated', environmentId)),
      configuration: async (environmentId, change) => parseEntryAnswer(await call('record', 'configuration', environmentId, change), environmentId),
      build: async (environmentId, change) => parseEntryAnswer(await call('record', 'build', environmentId, ...buildArguments(change)), environmentId),
    },
    secrets: {
      token: async () => {
        const answer = (await call('secret', 'token')) as { given?: unknown } | null;
        return answer !== null && typeof answer === 'object' && answer.given === true ? secretOf(HOST_SECRET_NAMES.token) : undefined;
      },
      registry: async (registry) => {
        const answer = (await call('secret', 'registry', registry)) as { given?: unknown; username?: unknown; identityToken?: unknown; serveraddress?: unknown } | null;
        if (answer === null || typeof answer !== 'object' || answer.given !== true) return undefined;
        const password = secretOf(HOST_SECRET_NAMES.registry);
        if (password === undefined) return undefined;
        const serveraddress = typeof answer.serveraddress === 'string' ? answer.serveraddress : registry;
        return {
          ...(typeof answer.username === 'string' ? { username: answer.username } : {}),
          ...(answer.identityToken === true ? { identityToken: true as const } : {}),
          serveraddress,
          password,
        };
      },
    },
    connect: {
      connect: async (data) => void (await call('connect', 'connect', data)),
    },
  };
}
