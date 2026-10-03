// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (decision of 2026-10-03, the worker is the deputy): the operations that run a whole flow in the worker.
// Each one builds the seams of the flow from the requests of its operation (workerHostSide) and the port of its engine
// (dockerEngine), runs the flow, and answers with its result. The first flow is the token removal; the flows of plan
// steps 11B2 to 11E come here too.
import { parseTokenRemoveParams, type TokenRemoveValue } from '../core/helperChannel/protocol';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { removeTokenFlow } from '../core/worker/tokenRemoveFlow';
import { workerHostSide } from '../core/worker/workerHostSide';
import type { HostRequest } from '../core/worker/hostSide';
import { OperationError, type OperationContext, type OperationHandler } from './server';

/** The seams of a flow from the context of its operation: its requests to the extension and its secrets. */
export function flowHost(context: OperationContext) {
  const ask: (request: HostRequest) => Promise<unknown> = (request) => context.ask(request.kind, { call: request.call, args: request.args });
  return workerHostSide(ask, (name) => context.secrets[name]);
}

/**
 * The port of the engine for one operation: with its own secrets for the standard input of an exec (review round 1 of
 * plan step 11B1, A-R1-3).
 */
export type EngineOfOperation = (context: OperationContext) => DockerEngine;

/** `tokenRemove`: empties the token folder of the dev container of an environment (concept section 9). */
export function tokenRemoveOperation(engineOf: EngineOfOperation): OperationHandler {
  return async (params, context) => {
    const checked = parseTokenRemoveParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the tokenRemove operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The tokenRemove operation takes no secret.');
    const host = flowHost(context);
    context.progress('tokenRemove', checked.containerName);
    try {
      const result = await removeTokenFlow({
        environmentId: checked.environmentId,
        containerName: checked.containerName,
        engine: engineOf(context),
        records: host.records,
        log: (line) => context.log(line),
        signal: context.signal,
      });
      context.log(
        result.outcome === 'removed'
          ? `The GitHub token was removed from the container ${checked.containerName}.`
          : `The container ${checked.containerName} does not run: its memory holds no GitHub token.`,
      );
      return result satisfies TokenRemoveValue;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError('failed', error instanceof Error ? error.message : String(error));
    }
  };
}
