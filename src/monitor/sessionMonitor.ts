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
import { acquireMonitorLock, refreshMonitorLock, releaseMonitorLock } from './lock';
import { MonitorDockerClient } from './monitorDocker';
import { FileLogger } from './monitorLog';
import { MonitorLoop } from './monitorLoop';

/** After SIGTERM or SIGINT, the current step gets this long before the process ends anyway. */
const SIGNAL_GRACE_MS = 3_000;

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
  let acquired: boolean;
  try {
    acquired = acquireMonitorLock(paths.monitorLock);
  } catch (error) {
    logger.error('The lock file of the Session Monitor could not be created.', error);
    return 1;
  }
  if (!acquired) return 0;

  const release = (): void => releaseMonitorLock(paths.monitorLock);
  process.once('exit', release);
  logger.info(`Session Monitor started (Node.js ${process.version}, ${process.platform}).`);

  const loop = new MonitorLoop({
    registry: new EnvironmentRegistry(paths, undefined, { logger }),
    sessionFiles: new SessionFiles(paths),
    docker: new MonitorDockerClient({ runner: new NodeProcessRunner(), env: process.env, platform: process.platform, logger }),
    logger,
    refreshLock: () => refreshMonitorLock(paths.monitorLock),
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
