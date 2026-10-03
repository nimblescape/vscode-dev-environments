// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B (decision of 2026-10-03, the worker is the deputy): the extension's side of the requests of a flow in the
// worker (plan step 11A, `OperationOptions.onAsk`). It checks every request, calls the HostSide of this computer, and
// answers with its value; a `secret` request answers with the secret in `secrets`, never in the value. No `vscode` here:
// the extension passes its own HostSide (src/vscode).
import { HOST_SECRET_NAMES, parseHostRequest, type HostCall, type HostSecretAnswer, type HostSide } from './hostSide';
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
/** The fields of a record that a flow may not change: its identity and its owner (review round 1 of plan step 11B1, A-R1-8). */
const FIXED_FIELDS = new Set(['id', 'owner', '__proto__', 'constructor', 'prototype']);

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
export function hostSideHandler(host: HostSide, logger: Logger, allowed: readonly HostCall[]): NonNullable<OperationOptions['onAsk']> {
  const permitted = new Set<string>(allowed);
  return async (kind, payload, signal) => {
    const request = parseHostRequest(payload, kind);
    if (request === undefined) throw new HelperOperationError('invalid', 'The request of the operation is invalid.', false);
    if (!permitted.has(`${request.kind} ${request.call}`)) {
      logger.warn(`The worker sent the request ${request.kind} ${request.call}, which its operation may not send.`);
      throw new HelperOperationError('invalid', `The operation may not send the request ${request.kind} ${request.call}.`, false);
    }
    if (signal.aborted) throw new HelperOperationError('cancelled', 'The operation ended.', false);
    try {
      return await answer(host, request.kind, request.call, request.args);
    } catch (error) {
      if (error instanceof HelperOperationError) throw error;
      logger.warn(`The request ${request.kind} ${request.call} of the worker failed: ${errorMessage(error)}`);
      throw new HelperOperationError('failed', errorMessage(error), false);
    }
  };
}

function strings(args: unknown[], count: number): string[] {
  const values = args.slice(0, count);
  if (values.length !== count || !values.every((value) => typeof value === 'string')) {
    throw new HelperOperationError('invalid', 'The arguments of the request are invalid.', false);
  }
  return values as string[];
}

async function answer(host: HostSide, kind: AskKind, call: string, args: unknown[]): Promise<Answer> {
  switch (kind) {
    case 'question':
      return { value: await question(host, call, args) };
    case 'local':
      return { value: await local(host, call, args) };
    case 'record':
      return { value: await record(host, call, args) };
    case 'secret':
      return secret(host, call, args);
    case 'connect': {
      if (call !== 'connect' || typeof args[0] !== 'object' || args[0] === null) {
        throw new HelperOperationError('invalid', `The request connect ${call} is unknown.`, false);
      }
      await host.connect.connect(args[0] as Parameters<HostSide['connect']['connect']>[0]);
      return { value: null };
    }
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
    default:
      throw new HelperOperationError('invalid', `The state ${call} is unknown.`, false);
  }
}

async function record(host: HostSide, call: string, args: unknown[]): Promise<unknown> {
  const records = host.records;
  switch (call) {
    case 'read':
      return records.read();
    case 'list':
      return records.list();
    case 'get':
      return (await records.get(strings(args, 1)[0])) ?? null;
    case 'findForAccount': {
      const [repository, accountId, dockerHost] = strings(args, 3);
      return (await records.findForAccount(repository, accountId, dockerHost)) ?? null;
    }
    case 'add': {
      const environment = args[0] as { id?: unknown; owner?: { id?: unknown } } | null;
      if (typeof environment !== 'object' || environment === null || Array.isArray(environment) || typeof environment.id !== 'string' || typeof environment.owner?.id !== 'string') {
        throw new HelperOperationError('invalid', 'The environment is invalid.', false);
      }
      await records.add(args[0] as Parameters<HostSide['records']['add']>[0]);
      return null;
    }
    case 'update': {
      const [id] = strings(args, 1);
      const changes = args[1];
      if (typeof changes !== 'object' || changes === null || Array.isArray(changes) || Object.keys(changes).some((key) => FIXED_FIELDS.has(key))) {
        throw new HelperOperationError('invalid', 'The changes are invalid.', false);
      }
      await records.update(id, args[1] as Parameters<HostSide['records']['update']>[1]);
      return null;
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
      if (!stringList(names)) throw new HelperOperationError('invalid', 'The volume names are invalid.', false);
      await records.forgetKeptVolumes(names as string[]);
      return null;
    }
    case 'sessionFile': {
      const [kind, environmentId] = strings(args, 2);
      const kinds = ['writePending', 'removePending', 'removeOperation', 'removeReopen', 'removeDisconnectRequest'] as const;
      if (!(kinds as readonly string[]).includes(kind)) throw new HelperOperationError('invalid', `The session file ${kind} is unknown.`, false);
      await records.sessionFile(kind as (typeof kinds)[number], environmentId);
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
