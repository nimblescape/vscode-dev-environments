// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR C: the real environment lock of the workers for the Docker test files of the open pipeline. Since this
// PR, every helper step of an open runs in the batch helper of the operation, which the worker that holds the lock starts
// (HeldEnvironmentLock.batch; rule D1: never a `docker run` of its own), so these files need the real workers, as
// extension.ts wires them (HelperChannels, openHelperChannel, the bundled worker script), with a state volume of the test.
// Records the batch helpers of each lock, so that a test can count them (one per operation). `dispose` closes the
// workers and returns the worker and batch helper containers that are left over.
// Plan step 11I1, PR A1: also the pieces that replace the relay of the worker in these files (11I1 removes the `lock` and
// `batch` operations): a holder of a lock in a plain container (holdLockInContainer, lockIsFree), and the batch helper of
// the worker started from the test process (inProcessBatches).
import type { EnvironmentStates, StateEnvironment } from '../../src/core/pipeline/refreshStates';
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { workerScriptsPlugin } from '../../scripts/workerScripts.mjs';
import type { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import type { DockerTarget } from '../../src/core/docker/dockerHost';
import type { DockerTargets } from '../../src/core/docker/dockerTargets';
import type { HeldEnvironmentLock } from '../../src/core/docker/environmentLock';
import { runWithBatchScope } from '../../src/core/helper/batchScope';
import { helperImageTag } from '../../src/core/helper/helperImage';
import type { HelperBatchSession } from '../../src/core/helperChannel/helperChannel';
import { HelperChannels, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import { LABEL_CHANNEL_STEP, LABEL_HELPER_CHANNEL, LOCK_BUSY_EXIT, LOCK_STATE_DIR } from '../../src/core/helperChannel/protocol';
import type { Logger } from '../../src/core/ports';
import { workerBatchSession } from '../../src/helperChannel/batch';
import { engineApi, engineHijack } from '../../src/helperChannel/engineApi';
import { dockerEngine } from '../../src/helperChannel/engineClient';
import { contextSecrets } from '../../src/helperChannel/operationContext.testkit';
import type { OperationContext } from '../../src/helperChannel/server';
import { TEST_RUN_LABEL } from './dockerRun';
import { HELPER_DOCKERFILE, testStateVolume, type DockerTestContext } from './harness';

let bundled: Promise<string> | undefined;

/** The worker script (dist/helperChannel.js) bundled from the sources, once per test process. */
export function workerScript(): Promise<string> {
  bundled ??= esbuild
    .build({
      // Plan step 11B3b: the compile-time constants of esbuild.mjs (the worker now bundles the workspace helper).
      define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) },
      // Plan step 11D2: the script of the Session Monitor in the worker, as esbuild.mjs bundles it.
      plugins: [workerScriptsPlugin(path.resolve(__dirname, '../..'), { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) })],
      entryPoints: [path.resolve(__dirname, '../../src/helperChannel/main.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      minify: true,
      write: false,
      logLevel: 'silent',
    })
    .then((result) => result.outputFiles[0].text);
  return bundled;
}

export interface WorkerLocks {
  readonly channels: HelperChannels;
  /** EnvironmentServiceDeps.environmentLock: the lock of the worker of the current Docker target. */
  take(environmentId: string, waitSeconds: number, signal: AbortSignal | undefined): Promise<HeldEnvironmentLock>;
  /** Plan step 11B2: EnvironmentServiceDeps.flow, a flow in the worker of the current Docker target (as extension.ts). */
  flow(op: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  /** Plan step 11C1: EnvironmentServiceDeps.workerRefresh, the refresh in the worker of the current Docker target (as extension.ts). */
  refresh(environments: readonly StateEnvironment[]): Promise<EnvironmentStates>;
  /** Plan step 11I1, PR A2: the names of the worker containers that this object started, in order. */
  readonly workerNames: string[];
  /** The batch helper sessions opened through the locks of `take`, per environment ID, in order. */
  readonly batches: Map<string, string[]>;
  /** The worker and batch helper containers of this object that still exist. */
  leftovers(): string[];
  /** Closes the workers; waits for their containers and the batch helpers to be gone, and returns those left over. */
  dispose(): Promise<string[]>;
}

/**
 * The workers of one window for a Docker test file (see the module comment). `socketPath`: the socket source of a worker
 * for its target (default: the local socket of the target, as extension.ts for a local engine).
 */
export function workerLocks(
  context: Pick<DockerTestContext, 'run' | 'cli' | 'log'>,
  docker: ContainerAdapter,
  targets: Pick<DockerTargets, 'current'>,
  name: string,
  socketPath: (target: DockerTarget) => Promise<string>,
  /** Plan step 11I1, PR A2 (decision D1 of 2026-10-07): `none` starts the workers without network (the offline scenarios). */
  options: { network?: 'none' } = {},
): WorkerLocks {
  const { run, cli, log } = context;
  const helperTag = helperImageTag(fs.readFileSync(HELPER_DOCKERFILE, 'utf8'));
  const batches = new Map<string, string[]>();
  const workerNames: string[] = [];
  const channels = new HelperChannels({
    logger: log,
    open: (target) =>
      openHelperChannel(
        {
          start: (args) => {
            const all = [...args];
            all.splice(all.indexOf(helperTag), 0, '--label', `${TEST_RUN_LABEL}=${run.runId}`);
            if (options.network !== undefined) all[all.indexOf('--network') + 1] = options.network;
            workerNames.push(all[all.indexOf('--name') + 1]);
            return docker.start(all);
          },
          runDirect: (args, options) => docker.runDirect(args, options),
          logger: log,
          script: workerScript,
          helperTag: async () => helperTag,
          socketPath: async () => socketPath(target),
          stateVolume: testStateVolume(context, name),
        },
        target,
      ),
  });
  const workerContainers = () => cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`]);
  const batchContainers = () => [...batches.values()].flat().flatMap((session) => cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_CHANNEL_STEP}=${session}`]));
  const leftovers = () => [...workerContainers(), ...batchContainers()];
  return {
    channels,
    workerNames,
    batches,
    leftovers,
    flow: async (op, params, options) => channels.flow(await targets.current(), op, params, options),
    refresh: async (environments) => channels.refresh(await targets.current(), environments),
    take: async (environmentId, waitSeconds, signal) => {
      const lock = await channels.lock(await targets.current(), environmentId, waitSeconds, signal);
      return {
        environmentId: lock.environmentId,
        lost: lock.lost,
        docker: (args, options) => lock.docker(args, options),
        // Plan step 10A: the operations over the Engine API of the worker that holds the lock.
        pull: (reference, options) => lock.pull!(reference, options),
        startContainers: (ids, options) => lock.startContainers!(ids, options),
        release: () => lock.release(),
        batch: async (p, batchSignal) => {
          const session = await lock.batch!(p, batchSignal);
          batches.set(environmentId, [...(batches.get(environmentId) ?? []), session.session]);
          return session;
        },
      };
    },
    dispose: async () => {
      channels.dispose();
      const deadline = Date.now() + 60_000;
      while (leftovers().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      return leftovers();
    },
  };
}

/**
 * Plan step 7 (user decision of 2026-10-01): the per-step path is removed, so a volume step of WorkspaceHelper runs only
 * in the batch scope of an operation. Runs `fn` as an operation does: under the lock of `lockId` (a storage ID) taken
 * through `locks` (10 s, D3), in the batch scope of `volume`; its batch helper is closed and the lock released at the end.
 */
export async function inBatchScope<T>(locks: WorkerLocks, lockId: string, volume: string, logger: Logger, fn: () => Promise<T>): Promise<T> {
  const lock = await locks.take(lockId, 10, undefined);
  try {
    return await runWithBatchScope(lock, volume, logger, fn);
  } finally {
    await lock.release();
  }
}

let lockHolderBundle: Promise<string> | undefined;

/** Plan step 11I1, PR A1 (review round 1, A-M1): lockHolder.ts bundled, once per test process. */
function lockHolderScript(): Promise<string> {
  lockHolderBundle ??= esbuild
    .build({ entryPoints: [path.resolve(__dirname, 'lockHolder.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', minify: true, write: false, logLevel: 'silent' })
    .then((result) => result.outputFiles[0].text);
  return lockHolderBundle;
}

/** The arguments of `docker run` of a lockHolder.ts container on the state volume (root, no network, no capabilities, as the worker). */
async function lockHolderArgs(context: Pick<DockerTestContext, 'run'>, stateVolume: string, helperTag: string, args: string[]): Promise<string[]> {
  return [
    '--label', `${TEST_RUN_LABEL}=${context.run.runId}`, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,source=${stateVolume},target=${LOCK_STATE_DIR}`,
    helperTag, 'node', '-e', await lockHolderScript(), ...args,
  ];
}

/**
 * Plan step 11I1, PR A1: the lock of an environment held by a plain container of the helper image on the state volume of
 * the workers, for a test that needs a holder elsewhere without the `lock` operation of the worker (removed by 11I1).
 * Review round 1 (A-M1): taken with the code of the worker and the Session Monitor (lockHolder.ts: openLockFile, then
 * `flock` on its file descriptor), so the lock file is the one that they make and check. Resolves once the lock is held;
 * `release` removes the container (the kernel lets go of the lock with its process).
 */
export async function holdLockInContainer(
  context: Pick<DockerTestContext, 'run' | 'cli'>,
  stateVolume: string,
  helperTag: string,
  environmentId: string,
): Promise<{ container: string; release(): void }> {
  const { cli } = context;
  const container = cli.ok(['run', '-d', ...(await lockHolderArgs(context, stateVolume, helperTag, ['hold', environmentId, '30']))]);
  const deadline = Date.now() + 45_000;
  while (!cli.run(['logs', container]).out.includes('held')) {
    if (Date.now() > deadline || cli.container(container)?.State.Running !== true) {
      const logs = cli.run(['logs', container]);
      cli.run(['rm', '-f', container]);
      throw new Error(`The lock of ${environmentId} was not taken by the holder container: ${logs.out} ${logs.err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Review round 2 (A-L2): a removal that fails is an error (else the lock stays held, and a later check reads busy).
  return { container, release: () => void cli.ok(['rm', '-f', container]) };
}

/**
 * Plan step 11I1, PR A1: whether the lock of an environment can be taken on the state volume within `waitSeconds` (a
 * plain container of the helper image takes it as a worker does, lockHolder.ts, and lets go at once): true when taken,
 * false when another holder kept it for the whole wait (LOCK_BUSY_EXIT).
 */
export async function lockIsFree(context: Pick<DockerTestContext, 'run' | 'cli'>, stateVolume: string, helperTag: string, environmentId: string, waitSeconds: number): Promise<boolean> {
  const result = context.cli.run(['run', '--rm', ...(await lockHolderArgs(context, stateVolume, helperTag, ['try', environmentId, String(waitSeconds)]))]);
  if (result.code !== 0 && result.code !== LOCK_BUSY_EXIT) throw new Error(`The lock of ${environmentId} could not be tried: ${result.err}`);
  return result.code === 0;
}

export interface InProcessBatches {
  /** Opens a batch session as the worker's own flow opens it (workerBatchSession), from the test process. */
  open(p: { volume: string; image: string; socket: string }, signal?: AbortSignal): Promise<HelperBatchSession>;
  /** The sessions opened, in order. */
  readonly sessions: string[];
  /**
   * Runs `fn` in the batch scope of `volume`, as an operation of the worker runs its helper steps (runWithBatchScope over
   * a held lock whose `batch` is `open`): its session is closed at the end.
   */
  inScope<T>(environmentId: string, volume: string, fn: () => Promise<T>): Promise<T>;
  /** The batch helper containers of the sessions that still exist. */
  leftovers(): string[];
  /** Ends the operation of the sessions; waits for their containers to be gone, and returns those left over. */
  dispose(): Promise<string[]>;
}

/**
 * Plan step 11I1, PR A1: the batch helper of the worker run from the test process (the pieces of the worker in process:
 * workerBatchSession with the bundled worker script, over the Engine API of `socket`, the socket of the engine as the
 * test process reaches it), for the steps of WorkspaceHelper that no flow sends directly, without the `batch` operation
 * of the worker (removed by 11I1). The helper is the one that a flow of the worker starts.
 */
export async function inProcessBatches(context: Pick<DockerTestContext, 'cli' | 'log'>, socket: string): Promise<InProcessBatches> {
  const { cli, log } = context;
  const script = await workerScript();
  const operation = new AbortController();
  const operationContext: OperationContext = {
    signal: operation.signal,
    ...contextSecrets(),
    progress: () => {},
    log: (text, level) => (level === 'warn' ? log.warn(text) : log.info(text)),
    output: () => {},
    docker: async () => {
      throw new Error('Plan step 11I1: the batch helper runs no Docker call of the worker.');
    },
  };
  const engine = dockerEngine(engineApi(socket), engineHijack(socket));
  const deps = { sessions: new Map(), engineOf: () => engine, readScript: () => script };
  const sessions: string[] = [];
  // Review round 1 (A-L3): the cancel of an open (its `signal`) ends that open, as the worker's operation would.
  const open = async (p: { volume: string; image: string; socket: string }, signal?: AbortSignal): Promise<HelperBatchSession> => {
    const context = signal === undefined ? operationContext : { ...operationContext, signal: AbortSignal.any([operation.signal, signal]) };
    const session = await workerBatchSession(deps, context, p);
    sessions.push(session.session);
    return session;
  };
  const leftovers = () => sessions.flatMap((session) => cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_CHANNEL_STEP}=${session}`]));
  return {
    open,
    sessions,
    leftovers,
    inScope: (environmentId, volume, fn) => {
      const lock: HeldEnvironmentLock = {
        environmentId,
        lost: new Promise<string>(() => {}),
        docker: async () => {
          throw new Error('Plan step 11I1: no Docker call through the lock.');
        },
        batch: (p, signal) => open(p, signal),
        release: async () => {},
      };
      return runWithBatchScope(lock, volume, log, fn);
    },
    dispose: async () => {
      operation.abort();
      const deadline = Date.now() + 60_000;
      while (leftovers().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      return leftovers();
    },
  };
}
