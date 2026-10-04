// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The operations of the helper channel (src/core/helperChannel/protocol.ts). Step 1: `docker` (one Docker call, for
// the calls that no operation covers yet) and `probe` (whether the Docker CLI of the container reaches its engine, and
// which engine: plan step 5, PR A), `refresh` (the states and branches of the environments: plan step 5, PR C). The
// later steps add operations that run whole batches here, next to the engine, and report their progress.
import { ContainerAdapter } from '../core/docker/containerAdapter';
import {
  ENGINE_IDENTITY_ARGS,
  OP_DOCKER,
  SECRET_TOKEN,
  OP_LOCK,
  OP_PROBE,
  OP_PULL,
  OP_START_CONTAINERS,
  OP_STOP,
  OP_TOKEN_REMOVE,
  OP_REFRESH,
  OP_SWEEP,
  engineIdentity,
  parseDockerOperationParams,
  parseRefreshParams,
  refreshValue,
  sweepArgs,
  type DockerOperationValue,
  type ProbeValue,
  type RefreshValue,
} from '../core/helperChannel/protocol';
import { readEnvironmentStates } from '../core/pipeline/refreshStates';
import { abortError, type Logger, type ProcessRunner } from '../core/ports';
import { OP_BATCH, OP_BATCH_CHUNK, OP_BATCH_STEP } from '../core/helperChannel/batch';
import { batchChunkOperation, batchDeps, batchOperation, batchStepOperation } from './batch';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine } from './engineClient';
import { stopOperation, tokenRemoveOperation, type EngineOfOperation } from './flowOperations';
import { pullOperation, startContainersOperation } from './engineOperations';
import { lockOperation } from './lock';
import { OperationError, type OperationContext, type OperationHandler } from './server';

/** `docker <args>`: its output goes back as it comes; the value is its exit code. */
export const dockerOperation: OperationHandler = async (params, context) => {
  const checked = parseDockerOperationParams(params);
  if (checked === undefined) throw new OperationError('invalid', 'The parameters of the docker operation are invalid.');
  let input = checked.input;
  if (checked.inputIsSecret === true) {
    // Plan step 11A: the secret input of a call is the GitHub token (the token write into the dev container).
    const token = context.secrets[SECRET_TOKEN];
    if (token === undefined) throw new OperationError('invalid', 'The docker operation expects a secret.');
    input = token;
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
  if (result.exitCode !== 0 || version === '') {
    const failed: ProbeValue = { detail: ((result.error ?? result.stderr.trim()) || `exit code ${result.exitCode}`).slice(-2_000) };
    return failed;
  }
  const value: ProbeValue = { serverVersion: version, detail: `Docker ${version}` };
  // Plan step 5, PR A: the identity of the engine behind the socket, which the extension compares with its own call.
  const identity = await context.docker(ENGINE_IDENTITY_ARGS);
  const engine = identity.exitCode === 0 ? engineIdentity(identity.stdout) : undefined;
  if (engine !== undefined) value.engine = engine;
  return value;
};

/** Review round 4 (M1): removes the channel containers that were created but never started (protocol.ts, OP_SWEEP). */
export const sweepOperation: OperationHandler = async (params, context) => {
  if (params !== null && params !== undefined && !(typeof params === 'object' && Object.keys(params).length === 0)) {
    throw new OperationError('invalid', 'The sweep operation takes no parameters.');
  }
  const result = await context.docker(sweepArgs());
  if (result.error !== undefined) throw new OperationError('failed', result.error);
  if (result.exitCode !== 0) throw new OperationError('failed', result.stderr.trim() || `exit code ${result.exitCode}`);
  return { output: result.stdout.trim().slice(-2_000) };
};

/**
 * Plan step 5, PR C: a ProcessRunner over the Docker CLI of the worker (OperationContext.docker), for a ContainerAdapter
 * in the worker. The program name is ignored (always `docker`); so are `env` and `cwd`: the worker never sets a
 * variable. It refuses an input (the refresh only reads, and never carries a secret). `timeoutMs` and `signal` end the
 * call alone; it resolves then with `timedOut`, or rejects with an AbortError, as NodeProcessRunner does.
 */
export function contextRunner(context: OperationContext): ProcessRunner {
  return {
    run: async (_file, args, options = {}) => {
      if (options.input !== undefined) throw new Error('The worker runs no Docker call with an input here.');
      if (options.signal?.aborted || context.signal.aborted) throw abortError();
      const controller = new AbortController();
      let timedOut = false;
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, options.timeoutMs);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await context.docker(args, { signal: controller.signal });
        if (options.signal?.aborted || context.signal.aborted) throw abortError();
        if (result.error !== undefined && !timedOut) throw new Error(result.error);
        return { exitCode: timedOut ? null : result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Plan step 5, PR C: the log of the extension as the Logger of a ContainerAdapter in the worker. */
function contextLogger(context: OperationContext): Logger {
  return {
    info: (message) => context.log(message),
    warn: (message) => context.log(message, 'warn'),
    error: (message) => context.log(message, 'warn'),
    output: () => {},
  };
}

/**
 * Plan step 5, PR C: `refresh`: readEnvironmentStates with a ContainerAdapter over the Docker CLI of the worker, the
 * same code as the refresh without the worker. It only reads; it takes no secret.
 */
export const refreshOperation: OperationHandler = async (params, context) => {
  const checked = parseRefreshParams(params);
  if (checked === undefined) throw new OperationError('invalid', 'The parameters of the refresh operation are invalid.');
  if (!context.hasNoSecret()) throw new OperationError('invalid', 'The refresh operation takes no secret.');
  context.progress('refresh');
  const docker = new ContainerAdapter(contextRunner(context), 'docker', {}, contextLogger(context), 'linux');
  const value: RefreshValue = refreshValue(await readEnvironmentStates(docker, checked.environments));
  return value;
};

/** Plan step 10A: the Engine API of the worker's engine, over its socket. */
const ENGINE = engineApi();

/** Plan step 11B1: the port of the engine for the flows that run in the worker (section 0 of the plan), per operation. */
const HIJACK = engineHijack();
const ENGINE_OF: EngineOfOperation = (context) => dockerEngine(ENGINE, HIJACK, (name) => context.secrets[name]);

/** Plan step 6, PR B: the batch sessions of this worker, shared by its three operations. */
const BATCH = batchDeps();

export const OPERATIONS: Readonly<Record<string, OperationHandler>> = {
  [OP_DOCKER]: dockerOperation,
  [OP_PROBE]: probeOperation,
  [OP_SWEEP]: sweepOperation,
  [OP_REFRESH]: refreshOperation,
  // Plan step 5, PR B: the environment lock (lock.ts).
  [OP_LOCK]: lockOperation(),
  // Plan step 6, PR B: the batch helper of an operation (batch.ts).
  [OP_BATCH]: batchOperation(BATCH),
  [OP_BATCH_STEP]: batchStepOperation(BATCH),
  [OP_BATCH_CHUNK]: batchChunkOperation(BATCH),
  // Plan step 10A (decision of 2026-10-03): operations over the Engine API of the worker's engine (engineOperations.ts).
  [OP_PULL]: pullOperation(ENGINE),
  [OP_START_CONTAINERS]: startContainersOperation(ENGINE),
  // Plan step 11B1: the flows that run in the worker (flowOperations.ts).
  [OP_TOKEN_REMOVE]: tokenRemoveOperation(ENGINE_OF),
  // Plan step 11B2: Stop, under the lock that the operation takes itself.
  [OP_STOP]: stopOperation(ENGINE_OF),
};
