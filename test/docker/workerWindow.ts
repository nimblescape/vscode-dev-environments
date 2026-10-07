// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I1, PR A2 (section 3b of the plan: the Docker tests drive the flows end to end through a real worker): a
// window of the extension for a Docker test file, as extension.ts wires it: the operations of the window
// (EnvironmentOperations) over extensionFlow and the extension's HostSide, with a registry and session files of its own
// (or of another window of the same computer), to the real workers of the engine (workerLocks). Every progress step of
// every flow is recorded (`steps`), so that a test counts the batch helpers of the worker (the step `batch`, one per
// session) without the lock of the extension. The Session Monitor that an open makes sure of is the real one of the
// engine (decision D9 of 2026-10-07): a test file skips its opens when the engine had one before the tests
// (monitorOfUser), and removes the one that it made (removeTestMonitor).
import * as fs from 'fs';
import * as path from 'path';
// Plan step 11I2: the Docker CLI of the extension (BootstrapDocker) in place of the removed CLI adapter ContainerAdapter.
import type { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import { helperImageTag } from '../../src/core/helper/helperImage';
import { monitorImageTag } from '../../src/core/helper/helperState';
import { helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { EnvironmentOperations, type EnvironmentOperationsDeps } from '../../src/core/pipeline/environmentOperations';
import { windowLifecycleMemory } from '../../src/core/pipeline/lifecycleMemory';
import { systemClock, type GitHubAuth } from '../../src/core/ports';
import { REMOTE_MONITOR_CONTAINER, REMOTE_MONITOR_VOLUME } from '../../src/core/remoteMonitor/protocol';
import { StoragePaths } from '../../src/core/storage/paths';
import { EnvironmentRegistry } from '../../src/core/storage/registry';
import { SessionFiles } from '../../src/core/storage/sessionFiles';
import type { ExtensionSettings } from '../../src/core/types';
import type { DockerTarget } from '../../src/core/docker/dockerHost';
import { extensionFlow, extensionHostSide } from '../../src/vscode/hostSide';
import { readBaseline } from './dockerRun';
import { FakeUi, HELPER_DOCKERFILE, fakeAuth, type DockerTestContext } from './harness';
import { workerLocks, type WorkerLocks } from './workerLocks';

/** The settings of a window of the tests (each test file changes what it needs). */
export function testSettings(overrides: Partial<ExtensionSettings> = {}): ExtensionSettings {
  return {
    reopenLastOnStartup: true,
    stopOnClose: true,
    waitingTimeSeconds: 30,
    updateImagesOnConnect: false,
    respectShutdownActionNone: false,
    owners: [],
    includeArchived: false,
    includeForks: false,
    refreshIntervalMinutes: 60,
    hostAccessChecksOff: [],
    // Review round 1 of PR #117 (A-L1): the real Session Monitor of the opens (decision D9) never stops a container of a
    // test for want of heartbeats while the test file runs.
    stopAfterMinutes: 1440,
    ...overrides,
  };
}

/** The records of a computer: one registry and the session files (shared by the windows of that computer). */
export interface TestComputer {
  paths: StoragePaths;
  registry: EnvironmentRegistry;
  sessionFiles: SessionFiles;
}

export function testComputer(context: Pick<DockerTestContext, 'run' | 'log'>, name: string): TestComputer {
  const paths = new StoragePaths(path.join(context.run.runDir, `${name}-storage`));
  paths.ensureDirectoriesSync();
  return { paths, registry: new EnvironmentRegistry(paths, systemClock, { logger: context.log }), sessionFiles: new SessionFiles(paths) };
}

/** One progress step of a flow of the window. */
export interface FlowStep {
  op: string;
  step: string;
  detail?: string;
}

export interface WorkerWindow extends TestComputer {
  readonly ui: FakeUi;
  readonly locks: WorkerLocks;
  readonly targets: DockerTargets;
  /** The operations of the window (the pipeline runs in the worker). */
  readonly service: EnvironmentOperations;
  /** The settings of the window; a test changes them in place. */
  readonly settings: ExtensionSettings;
  readonly owner: { windowId: string; pid: number };
  /** Every progress step of every flow of this window, in order. */
  readonly steps: FlowStep[];
  /** The batch helpers that the worker started for `volume` since `from` (an index into `steps`). */
  batchesOf(volume: string, from?: number): number;
  /** Closes the workers; waits for their containers and batch helpers to be gone, and returns those left over. */
  dispose(): Promise<string[]>;
}

export interface WorkerWindowOptions {
  /** The name of the state volume of the workers (one per test file: the windows of a file share their locks). */
  name: string;
  /** The records of this window's computer (default: a computer of its own, named after `name`). */
  computer?: TestComputer;
  settings?: Partial<ExtensionSettings>;
  /** The user interface of the window (default: a FakeUi that answers as the user would). */
  ui?: FakeUi;
  auth?: GitHubAuth;
  windowId?: string;
  /** The socket source of a worker for its target (default: the local socket of the target, as extension.ts). */
  socketPath?: (target: DockerTarget) => Promise<string>;
  /** Decision D1 of 2026-10-07: `none` for a window whose workers have no network (the offline scenarios). */
  network?: 'none';
  /** The start of Docker before an open (default: nothing, the engine of the tests runs). */
  startDocker?: EnvironmentOperationsDeps['startDocker'];
}

/** A window of the extension for a Docker test file (see the module comment). */
export function workerWindow(context: DockerTestContext, docker: BootstrapDocker, options: WorkerWindowOptions): WorkerWindow {
  const { run, env, cli, log } = context;
  const computer = options.computer ?? testComputer(context, options.name);
  const ui = options.ui ?? new FakeUi();
  const settings = testSettings(options.settings);
  const owner = { windowId: options.windowId ?? `docker-test-${options.name}`, pid: process.pid };
  const targets = new DockerTargets(docker, env, log);
  const socketPath = options.socketPath ?? (async (target: DockerTarget) => helperDockerSocket(env, process.platform, target.endpoint));
  const locks = workerLocks({ run, cli, log }, docker, targets, options.name, socketPath, options.network === undefined ? {} : { network: options.network });
  const memory = windowLifecycleMemory();
  const auth = options.auth ?? fakeAuth;
  const steps: FlowStep[] = [];
  const extension = extensionFlow(
    locks.channels,
    () => targets.current(),
    extensionHostSide({
      registry: computer.registry,
      sessionFiles: computer.sessionFiles,
      ui,
      auth,
      credentials: { getForPull: async () => undefined },
      settings: () => settings,
      windowId: owner.windowId,
      pid: owner.pid,
      clock: systemClock,
      isProcessAlive: (pid) => pid === process.pid,
      lifecycleMemory: memory,
      logger: log,
    }),
    log,
  );
  // Every step of every flow is recorded, and passed on to the observer of the operation (the progress of the open).
  const flow: typeof extension = (op, params, flowOptions) =>
    extension(op, params, {
      ...flowOptions,
      onProgress: (step, detail) => {
        steps.push({ op, step, ...(detail === undefined ? {} : { detail }) });
        flowOptions.onProgress?.(step, detail);
      },
    });
  const service = new EnvironmentOperations({
    flow,
    workerRefresh: (environments) => locks.refresh(environments),
    dockerRunning: () => docker.isRunning(),
    // Review round 1 of PR #117 (B-H1): the Docker target of the window, as extension.ts (the Docker host of its records).
    dockerTarget: () => targets.current(),
    registry: computer.registry,
    sessionFiles: computer.sessionFiles,
    auth,
    ui,
    logger: log,
    clock: systemClock,
    owner,
    settings: () => settings,
    windowStatuses: () => computer.sessionFiles.readWindowStatuses(),
    lifecycleMemory: memory,
    // The Docker engine of the tests runs; nothing to start here (unless the test file starts it).
    startDocker: options.startDocker ?? (async () => {}),
    monitorSource: () => '0123456789abcdef0123456789abcdef',
    openMonitor: () => ({ images: { prefixes: [], schedule: '7 6 * * *', timeZone: 'UTC' }, listSent: () => {} }),
  });
  return {
    ...computer,
    ui,
    locks,
    targets,
    service,
    settings,
    owner,
    steps,
    batchesOf: (volume, from = 0) => steps.slice(from).filter((entry) => entry.step === 'batch' && entry.detail === volume).length,
    dispose: () => locks.dispose(),
  };
}

/** Decision D9 of 2026-10-07: whether the engine had a Session Monitor before the tests (its opens are skipped then). */
export function monitorOfUser(context: Pick<DockerTestContext, 'run'>): boolean {
  const baseline = readBaseline(context.run);
  return baseline.containers.some((container) => container.name === REMOTE_MONITOR_CONTAINER) || baseline.volumes.includes(REMOTE_MONITOR_VOLUME);
}

/** Decision D9 of 2026-10-07: removes the Session Monitor that the opens of a test file made, its state volume and its tag. */
export function removeTestMonitor(context: Pick<DockerTestContext, 'run' | 'cli'>): void {
  if (monitorOfUser(context)) return;
  context.cli.run(['rm', '-f', REMOTE_MONITOR_CONTAINER]);
  context.cli.run(['volume', 'rm', REMOTE_MONITOR_VOLUME]);
  const tag = monitorImageTag(helperImageTag(fs.readFileSync(HELPER_DOCKERFILE, 'utf8')));
  if (tag !== undefined) context.cli.run(['image', 'rm', tag]);
}
