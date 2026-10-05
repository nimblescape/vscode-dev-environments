// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The options of the BootstrapDocker of the extension (extension.ts): how the adapter reports to the Docker setup.
import type { BootstrapDockerOptions } from '../core/docker/bootstrapDocker';
import { findDockerCli } from '../core/docker/dockerCli';
import type { DockerSetup } from './dockerSetup';

/** The part of DockerSetup the adapter reports to. */
export type DockerSetupReports = Pick<DockerSetup, 'reportDaemonStatus' | 'reportCliLost'>;

/**
 * @param dockerSetup The Docker setup, once it exists (it is built after the adapter); reports before are dropped.
 */
export function dockerAdapterOptions(dockerSetup: () => DockerSetupReports | undefined): BootstrapDockerOptions {
  return {
    // Docker Desktop installed or updated while VS Code runs is found without a reload.
    findDocker: findDockerCli,
    // Each `docker info` that ran anyway (context key devEnvironments.dockerReady).
    onDaemonStatus: (running) => dockerSetup()?.reportDaemonStatus(running),
    // Docker was uninstalled or moved while VS Code runs: the sidebar shows the Docker setup again, without a lookup
    // (review round 2, W2-2; the next call of the adapter looks the CLI up again).
    onCliLost: () => dockerSetup()?.reportCliLost(),
  };
}
