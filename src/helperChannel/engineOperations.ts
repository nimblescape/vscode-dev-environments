// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 10A (decision of 2026-10-03, "every remote action is a worker operation"): the operations of the worker that
// talk to the Docker Engine API itself (engineApi.ts), without a `docker` process and without a container: `pull` and
// `startContainers` (protocol.ts).
import { SECRET_REGISTRY, parsePullParams, parseStartContainersParams } from '../core/helperChannel/protocol';
import type { EngineApi } from './engineApi';
import type { EngineOfOperation } from './flowOperations';
import { engineErrorMessage } from './engineApi';
import { OperationError, type OperationContext, type OperationHandler } from './server';

/**
 * `pull`: POST /images/create?fromImage=<reference> through the port of the engine (DockerEngine.pull, plan step 11B3:
 * one pull for the operation and the flows), the registry credentials only in its header.
 */
export function pullOperation(engineOf: EngineOfOperation): OperationHandler {
  return async (params, context: OperationContext) => {
    const checked = parsePullParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the pull operation are invalid.');
    // Plan step 11A: the registry password or identity token is the secret SECRET_REGISTRY, and the only one.
    const password = context.secrets[SECRET_REGISTRY];
    if (Object.keys(context.secrets).some((name) => name !== SECRET_REGISTRY)) throw new OperationError('invalid', 'The pull operation takes no secret but the registry login.');
    if ((password === undefined) !== (checked.serveraddress === undefined)) {
      throw new OperationError('invalid', 'The pull operation takes a secret exactly with a server (and a user or an identity token).');
    }
    context.log(`pull ${checked.reference}${checked.serveraddress !== undefined ? ` (with the credentials for ${checked.serveraddress})` : ''}`);
    const startedAt = Date.now();
    try {
      await engineOf(context).pull(checked.reference, {
        ...(checked.serveraddress !== undefined
          ? {
              login: {
                serveraddress: checked.serveraddress,
                ...(checked.username !== undefined ? { username: checked.username } : {}),
                ...(checked.identityToken === true ? { identityToken: true } : {}),
                secretName: SECRET_REGISTRY,
              },
            }
          : {}),
        onLine: (line) => context.output('stdout', `${line}\n`),
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      throw new OperationError('failed', `The pull of ${checked.reference} failed after ${seconds} s: ${error instanceof Error ? error.message : String(error)}`);
    }
    context.log(`pull ${checked.reference}: done after ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
    return {};
  };
}

/** `startContainers`: POST /containers/<id>/start of each container; 204 (started) and 304 (running already) count. */
export function startContainersOperation(engine: EngineApi): OperationHandler {
  return async (params, context: OperationContext) => {
    const checked = parseStartContainersParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the startContainers operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The startContainers operation takes no secret.');
    for (const id of checked.ids) {
      context.log(`start ${id.slice(0, 12)}`);
      const answer = await engine({ method: 'POST', path: `/containers/${id}/start`, signal: context.signal });
      if (answer.status !== 204 && answer.status !== 304) {
        throw new OperationError('failed', `The container ${id.slice(0, 12)} could not be started: ${engineErrorMessage(answer)}`);
      }
    }
    return {};
  };
}
