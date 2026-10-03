// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 10A (decision of 2026-10-03, "every remote action is a worker operation"): the operations of the worker that
// talk to the Docker Engine API itself (engineApi.ts), without a `docker` process and without a container: `pull` and
// `startContainers` (protocol.ts).
import { SECRET_REGISTRY, parsePullParams, parseStartContainersParams } from '../core/helperChannel/protocol';
import type { EngineApi } from './engineApi';
import { engineErrorMessage } from './engineApi';
import { OperationError, type OperationContext, type OperationHandler } from './server';

/**
 * The value of the header X-Registry-Auth: the credentials as JSON in URL-safe Base64 **with** its padding, as the
 * Docker CLI sends them (Go's base64.URLEncoding). Review round 1 of PR #89 (A-R1-1): the engine decodes it strictly and
 * ignores a header it cannot decode, so Node's `base64url` (without `=`) made it pull anonymously in 2 of 3 cases.
 * `identitytoken`: an identity token of `docker login` instead of a user and password (A-R1-3).
 */
export function registryAuthHeader(credentials: { username: string; password: string; serveraddress: string } | { identitytoken: string; serveraddress: string }): string {
  return Buffer.from(JSON.stringify(credentials), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

interface PullMessage {
  status?: unknown;
  id?: unknown;
  progressDetail?: { current?: unknown };
  error?: unknown;
  errorDetail?: { message?: unknown };
}

/**
 * The line of `docker pull` for one message of the engine's progress stream, or undefined for the progress bars of a
 * layer (`Downloading`, `Extracting` with a current size), which `docker pull` without a terminal does not print either.
 */
export function pullLine(message: PullMessage): string | undefined {
  if (typeof message.status !== 'string') return undefined;
  if (message.progressDetail !== undefined && typeof message.progressDetail === 'object' && message.progressDetail !== null && message.progressDetail.current !== undefined) {
    return undefined;
  }
  return typeof message.id === 'string' && message.id !== '' ? `${message.id}: ${message.status}` : message.status;
}

/** `pull`: POST /images/create?fromImage=<reference>, with the registry credentials only in its header. */
export function pullOperation(engine: EngineApi): OperationHandler {
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
    const headers: Record<string, string> = {};
    if (checked.serveraddress !== undefined && password !== undefined) {
      headers['X-Registry-Auth'] = registryAuthHeader(
        checked.identityToken === true
          ? { identitytoken: password, serveraddress: checked.serveraddress }
          : { username: checked.username ?? '', password, serveraddress: checked.serveraddress },
      );
    }
    let pending = '';
    // The start of the answer, for the message of an error answer (its body is one JSON object, not a stream).
    let head = '';
    let failure: string | undefined;
    const handleLine = (line: string) => {
      if (line.trim() === '') return;
      let message: PullMessage;
      try {
        message = JSON.parse(line) as PullMessage;
      } catch {
        context.output('stdout', `${line}\n`);
        return;
      }
      if (typeof message !== 'object' || message === null) return;
      if (message.error !== undefined || message.errorDetail !== undefined) {
        const text = typeof message.errorDetail?.message === 'string' ? message.errorDetail.message : String(message.error);
        failure ??= text;
        return;
      }
      const text = pullLine(message);
      if (text !== undefined) context.output('stdout', `${text}\n`);
    };
    const startedAt = Date.now();
    const answer = await engine({
      method: 'POST',
      path: `/images/create?fromImage=${encodeURIComponent(checked.reference)}`,
      headers,
      signal: context.signal,
      onChunk: (chunk) => {
        if (head.length < 2_000) head += chunk.slice(0, 2_000 - head.length);
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          handleLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      },
    });
    handleLine(pending);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (answer.status !== 200) {
      throw new OperationError('failed', `The pull of ${checked.reference} failed after ${seconds} s: ${failure ?? engineErrorMessage({ ...answer, body: head })}`);
    }
    if (failure !== undefined) throw new OperationError('failed', `The pull of ${checked.reference} failed after ${seconds} s: ${failure}`);
    context.log(`pull ${checked.reference}: done after ${seconds} s`);
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
