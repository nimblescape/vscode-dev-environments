// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The operations of the helper channel (src/core/helperChannel/protocol.ts). Step 1: `docker` (one Docker call, for
// the calls that no operation covers yet) and `probe` (whether the Docker CLI of the container reaches its engine). The
// later steps add operations that run whole batches here, next to the engine, and report their progress.
import {
  OP_DOCKER,
  OP_PROBE,
  parseDockerOperationParams,
  type DockerOperationValue,
  type ProbeValue,
} from '../core/helperChannel/protocol';
import { OperationError, type OperationHandler } from './server';

/** `docker <args>`: its output goes back as it comes; the value is its exit code. */
export const dockerOperation: OperationHandler = async (params, context) => {
  const checked = parseDockerOperationParams(params);
  if (checked === undefined) throw new OperationError('invalid', 'The parameters of the docker operation are invalid.');
  let input = checked.input;
  if (checked.inputIsSecret === true) {
    if (context.secret === undefined) throw new OperationError('invalid', 'The docker operation expects a secret.');
    input = context.secret;
  }
  const result = await context.docker(checked.args, {
    input,
    discardStdout: true,
    onStdout: (text) => context.output('stdout', text),
    onStderr: (text) => context.output('stderr', text),
    cleanup: checked.cleanup,
  });
  if (result.error !== undefined) throw new OperationError('failed', result.error);
  const value: DockerOperationValue = { exitCode: result.exitCode };
  return value;
};

/** `docker version`: the server version of the engine behind the socket of the container. */
export const probeOperation: OperationHandler = async (params, context) => {
  if (params !== null && params !== undefined && !(typeof params === 'object' && Object.keys(params).length === 0)) {
    throw new OperationError('invalid', 'The probe operation takes no parameters.');
  }
  context.progress('probe');
  // The time limit is the one of the request (the extension sets it).
  const result = await context.docker(['version', '--format', '{{.Server.Version}}']);
  const version = result.stdout.trim();
  const value: ProbeValue =
    result.exitCode === 0 && version !== ''
      ? { serverVersion: version, detail: `Docker ${version}` }
      : { detail: (result.error ?? result.stderr.trim()) || `exit code ${result.exitCode}` };
  return value;
};

export const OPERATIONS: Readonly<Record<string, OperationHandler>> = {
  [OP_DOCKER]: dockerOperation,
  [OP_PROBE]: probeOperation,
};
