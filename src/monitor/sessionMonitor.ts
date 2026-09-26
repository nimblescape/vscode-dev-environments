// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Entry point of the Session Monitor process, bundled to dist/sessionMonitor.js (concept 7.9, implementation notes 12).
// A window starts it detached with the Node.js runtime of VS Code:
//   ELECTRON_RUN_AS_NODE=1 <VS Code executable> dist/sessionMonitor.js <global storage folder>
// It uses only Node.js built-ins, src/core, and src/monitor. It runs until no window is alive and no waiting time runs.
import * as fs from 'fs';
import * as path from 'path';
import { NodeProcessRunner } from '../core/process';
import { EnvironmentRegistry } from '../core/storage/registry';
import { StoragePaths } from '../core/storage/paths';
import { SessionFiles } from '../core/storage/sessionFiles';
import {
  acquireMonitorLock,
  isMonitorExitRequested,
  refreshMonitorLock,
  releaseMonitorLock,
  removeLeftoverExitRequest,
  waitForRetiringMonitor,
  writeMonitorVersion,
  MONITOR_PROTOCOL_VERSION,
} from './lock';
import { MonitorDockerClient } from './monitorDocker';
import { FileLogger } from './monitorLog';
import { MonitorLoop } from './monitorLoop';

/** After SIGTERM or SIGINT, the current step gets this long before the process ends anyway. */
const SIGNAL_GRACE_MS = 3_000;
/**
 * A new monitor waits this long for an older monitor that a window asked to exit (monitor.exit, review finding F2 of
 * PR #26). The older one may be in a `docker stop` (up to 10 seconds) after a `git status` in the container. After this
 * time the new monitor tries the lock once and ends if it is still held; the window starts another one later.
 */
const RETIRING_MONITOR_WAIT_MS = 60_000;

/**
 * Runs the Session Monitor for the storage folder `argv[2]`. Resolves with the exit code: 0 when it ended normally or
 * another monitor runs, 1 on an unexpected error, 2 without a storage folder argument.
 */
export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const rootArgument = argv[2];
  if (!rootArgument) return 2;
  const root = path.resolve(rootArgument);
  // Without the storage folder there is nothing to watch (for example after the extension was removed).
  if (!isDirectory(root)) return 0;

  const paths = new StoragePaths(root);
  const logger = new FileLogger(paths.monitorLog);
  // Only an exit request written after this time ends this monitor: a leftover request may name its process ID.
  const startedAt = Date.now();
  // A request that does not name a live monitor of an older version is left over (round-2 review finding 2 of PR #26).
  removeLeftoverExitRequest(paths.monitorLock, paths.monitorVersion, paths.monitorExit);
  // A window asked an older monitor to exit and started this one: it finishes its current step first.
  if (!(await waitForRetiringMonitor(paths.monitorLock, paths.monitorExit, { timeoutMs: RETIRING_MONITOR_WAIT_MS }))) {
    logger.info('The older Session Monitor did not end in time.');
  }
  let acquired: boolean;
  try {
    acquired = acquireMonitorLock(paths.monitorLock);
  } catch (error) {
    logger.error('The lock file of the Session Monitor could not be created.', error);
    return 1;
  }
  if (!acquired) return 0;
  // The older monitor has ended: its request is left over. Before the version is written, so that no request of a
  // window that has read this version is removed.
  removeLeftoverExitRequest(paths.monitorLock, paths.monitorVersion, paths.monitorExit);
  try {
    writeMonitorVersion(paths.monitorVersion);
  } catch (error) {
    // Without its version a window leaves this monitor alone (unknown version); it still does its work.
    logger.error('The version file of the Session Monitor could not be written. It keeps running.', error);
  }

  const release = (): void => releaseMonitorLock(paths.monitorLock);
  process.once('exit', release);
  logger.info(
    `Session Monitor started (protocol version ${MONITOR_PROTOCOL_VERSION}, Node.js ${process.version}, ${process.platform}).`,
  );

  let exitRequested = false;
  // Checked in every tick (refreshLock): a window of a newer version asks this monitor to exit. It ends after its
  // current step, so a `docker stop` that has started is finished; it keeps the lock until then.
  const checkExitRequest = (): void => {
    if (exitRequested || !isMonitorExitRequested(paths.monitorExit, process.pid, startedAt)) return;
    exitRequested = true;
    logger.info('A window of a newer version asked this Session Monitor to exit.');
    loop.stop();
  };
  const loop: MonitorLoop = new MonitorLoop({
    registry: new EnvironmentRegistry(paths, undefined, { logger }),
    sessionFiles: new SessionFiles(paths),
    docker: new MonitorDockerClient({ runner: new NodeProcessRunner(), env: process.env, platform: process.platform, logger }),
    logger,
    refreshLock: () => {
      checkExitRequest();
      return refreshMonitorLock(paths.monitorLock);
    },
  });

  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info(`Received ${signal}.`);
    loop.stop();
    setTimeout(() => {
      release();
      process.exit(0);
    }, SIGNAL_GRACE_MS).unref();
  };
  // SIGHUP is ignored: the monitor must outlive VS Code and a terminal it may have been started from (concept 7.9).
  const onHangUp = (): void => logger.info('Ignored SIGHUP.');
  const onFatal = (error: unknown): void => {
    logger.error('Unexpected error. The Session Monitor ends.', error);
    release();
    process.exit(1);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGHUP', onHangUp);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);

  try {
    const reason = await loop.run();
    logger.info(`Session Monitor ends (${reason}).`);
    return 0;
  } catch (error) {
    logger.error('The Session Monitor failed.', error);
    return 1;
  } finally {
    release();
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGHUP', onHangUp);
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onFatal);
    process.removeListener('exit', release);
  }
}

function isDirectory(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

// Only when this file is the entry module (dist/sessionMonitor.js), not when a test imports it.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
