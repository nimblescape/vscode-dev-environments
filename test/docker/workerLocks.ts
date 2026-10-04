// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR C: the real environment lock of the workers for the Docker test files of the open pipeline. Since this
// PR, every helper step of an open runs in the batch helper of the operation, which the worker that holds the lock starts
// (HeldEnvironmentLock.batch; rule D1: never a `docker run` of its own), so these files need the real workers, as
// extension.ts wires them (HelperChannels, openHelperChannel, the bundled worker script), with a state volume of the test.
// Records the batch helpers of each lock, so that a test can count them (one per operation). `dispose` closes the
// workers and returns the worker and batch helper containers that are left over.
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import type { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import type { DockerTarget } from '../../src/core/docker/dockerHost';
import type { DockerTargets } from '../../src/core/docker/dockerTargets';
import type { HeldEnvironmentLock } from '../../src/core/docker/environmentLock';
import { runWithBatchScope } from '../../src/core/helper/batchScope';
import { helperImageTag } from '../../src/core/helper/helperImage';
import { HelperChannels, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import { LABEL_CHANNEL_STEP, LABEL_HELPER_CHANNEL } from '../../src/core/helperChannel/protocol';
import type { Logger } from '../../src/core/ports';
import { TEST_RUN_LABEL } from './dockerRun';
import { HELPER_DOCKERFILE, testStateVolume, type DockerTestContext } from './harness';

let bundled: Promise<string> | undefined;

/** The worker script (dist/helperChannel.js) bundled from the sources, once per test process. */
export function workerScript(): Promise<string> {
  bundled ??= esbuild
    .build({
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
): WorkerLocks {
  const { run, cli, log } = context;
  const helperTag = helperImageTag(fs.readFileSync(HELPER_DOCKERFILE, 'utf8'));
  const batches = new Map<string, string[]>();
  const channels = new HelperChannels({
    logger: log,
    open: (target) =>
      openHelperChannel(
        {
          start: (args) => {
            const all = [...args];
            all.splice(all.indexOf(helperTag), 0, '--label', `${TEST_RUN_LABEL}=${run.runId}`);
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
    batches,
    leftovers,
    flow: async (op, params, options) => channels.flow(await targets.current(), op, params, options),
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
