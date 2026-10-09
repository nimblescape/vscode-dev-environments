// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR C: the real workers for the Docker test files of the open pipeline, as extension.ts wires them
// (HelperChannels, openHelperChannel, the bundled worker script), with a state volume of the test. Their flows take the
// environment lock and start the batch helper of an operation in the worker. `dispose` closes the workers and returns
// the worker and batch helper containers that are left over.
// Plan step 11I1, PR A1: also the pieces that replace the relay of the worker in these files (11I1 removes the `lock` and
// `batch` operations): a holder of a lock in a plain container (holdLockInContainer, lockIsFree), and the batch helper of
// the worker started from the test process (inProcessBatches). Plan step 11I1, PR B1: the lock through the relay
// (WorkerLocks.take, its batch helpers, inBatchScope) is gone with those operations.
import type { EnvironmentStates, StateEnvironment } from '../../src/core/pipeline/refreshStates';
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { workerScriptsPlugin } from '../../scripts/workerScripts.mjs';
// Plan step 11I2: the Docker CLI of the extension (BootstrapDocker) in place of the removed CLI adapter ContainerAdapter.
import type { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import type { DockerTarget } from '../../src/core/docker/dockerHost';
import type { DockerTargets } from '../../src/core/docker/dockerTargets';
import type { HeldEnvironmentLock } from '../../src/core/docker/environmentLock';
import { runWithBatchScope } from '../../src/core/helper/batchScope';
import { helperImageTag } from '../../src/core/helper/helperImage';
import type { HelperBatchSession } from '../../src/core/helperChannel/helperChannel';
import { HelperChannels, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import { LABEL_CHANNEL_STEP, LABEL_HELPER_CHANNEL, LOCK_BUSY_EXIT, LOCK_STATE_DIR } from '../../src/core/helperChannel/protocol';
import { workerBatchSession } from '../../src/helperChannel/batch';
import { engineApi, engineHijack } from '../../src/helperChannel/engineApi';
import { dockerEngine } from '../../src/helperChannel/engineClient';
import { contextSecrets } from '../../src/helperChannel/operationContext.testkit';
import type { OperationContext } from '../../src/helperChannel/server';
import { TEST_RUN_LABEL, readBaseline } from './dockerRun';
import { HELPER_DOCKERFILE, testStateVolume, testVscodeVolume, type DockerTestContext } from './harness';

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
  /** Plan step 11B2: EnvironmentServiceDeps.flow, a flow in the worker of the current Docker target (as extension.ts). */
  flow(op: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  /** Plan step 11C1: EnvironmentServiceDeps.workerRefresh, the refresh in the worker of the current Docker target (as extension.ts). */
  refresh(environments: readonly StateEnvironment[]): Promise<EnvironmentStates>;
  /** Plan step 11I1, PR A2: the names of the worker containers that this object started, in order. */
  readonly workerNames: string[];
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
  docker: BootstrapDocker,
  targets: Pick<DockerTargets, 'current'>,
  name: string,
  socketPath: (target: DockerTarget) => Promise<string>,
  /** Plan step 11I1, PR A2 (decision D1 of 2026-10-07): `none` starts the workers without network (the offline scenarios). */
  options: { network?: 'none' } = {},
): WorkerLocks {
  const { run, cli, log } = context;
  const helperTag = helperImageTag(fs.readFileSync(HELPER_DOCKERFILE, 'utf8'));
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
          runDirect: (args, options) => docker.run(args, options),
          logger: log,
          script: workerScript,
          helperTag: async () => helperTag,
          socketPath: async () => socketPath(target),
          stateVolume: testStateVolume(context, name),
          // Plan step 11H1: the shared VS Code server store, a volume of the test file.
          vscodeVolume: testVscodeVolume(context, name),
        },
        target,
      ),
  });
  // Review round 1 of PR #117 (A-H2): only the workers that this object started (the leftovers of one window, which the
  // other windows of a test file do not hold up).
  const workerContainers = () =>
    cli.lines(['ps', '-a', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`, '--format', '{{.Names}}']).filter((name) => workerNames.includes(name));
  // Review round 1 of PR #117 (A-M1): the batch helpers that the flows of the workers start (workerBatchSession) carry no
  // label of the run; the test files run one at a time, so every batch helper that the engine did not have before the
  // tests is one of this file.
  const baselineNames = new Set(readBaseline(run).containers.map((container) => container.name));
  const flowBatchContainers = () => cli.lines(['ps', '-a', '--filter', `label=${LABEL_CHANNEL_STEP}`, '--format', '{{.Names}}']).filter((name) => !baselineNames.has(name));
  const leftovers = () => [...new Set([...workerContainers(), ...flowBatchContainers()])];
  return {
    channels,
    workerNames,
    leftovers,
    flow: async (op, params, options) => channels.flow(await targets.current(), op, params, options),
    refresh: async (environments) => channels.refresh(await targets.current(), environments),
    dispose: async () => {
      channels.dispose();
      const deadline = Date.now() + 60_000;
      while (leftovers().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      return leftovers();
    },
  };
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
  };
  const engine = dockerEngine(engineApi(socket), engineHijack(socket));
  const deps = { engineOf: () => engine, readScript: () => script };
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
