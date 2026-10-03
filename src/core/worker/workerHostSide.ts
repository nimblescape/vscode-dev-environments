// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B (decision of 2026-10-03, the worker is the deputy): the HostSide of a flow that runs in the worker. Every
// call becomes a request of its kind to the extension (plan step 11A, `OperationContext.ask`), which answers it. Pure
// over `ask`; no I/O of its own, no `vscode`.
import type { Environment, RegistryFile, WindowStatus } from '../types';
import { HOST_SECRET_NAMES, type HostRequest, type HostSide } from './hostSide';

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
      message: async (kind, text) => void (await call('question', 'message', kind, text)),
    },
    state: {
      windowStatuses: async () => ((await call('local', 'windowStatuses')) ?? []) as readonly WindowStatus[],
      pendings: async () => ((await call('local', 'pendings')) ?? []) as readonly { environmentId: string; windowId: string; createdAt: string }[],
      settings: async () => ((await call('local', 'settings')) ?? {}) as Record<string, unknown>,
      processAlive: async (pid) => (await call('local', 'processAlive', pid)) === true,
    },
    records: {
      read: async () => (await call('record', 'read')) as RegistryFile,
      get: async (id) => ((await call('record', 'get', id)) ?? undefined) as Environment | undefined,
      list: async () => ((await call('record', 'list')) ?? []) as Environment[],
      findForAccount: async (repository, accountId, dockerHost) =>
        ((await call('record', 'findForAccount', repository, accountId, dockerHost)) ?? undefined) as Environment | undefined,
      add: async (environment) => void (await call('record', 'add', environment)),
      update: async (id, changes) => void (await call('record', 'update', id, changes)),
      remove: async (id, volumes) => void (await call('record', 'remove', id, volumes)),
      forgetKeptVolumes: async (names) => void (await call('record', 'forgetKeptVolumes', [...names])),
      sessionFile: async (kind, environmentId) => void (await call('record', 'sessionFile', kind, environmentId)),
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
