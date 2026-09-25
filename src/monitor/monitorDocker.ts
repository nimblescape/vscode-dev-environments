// Docker access of the Session Monitor process: the Container Adapter with short time limits, and a Docker CLI that is
// looked up again when it was not found (for example while Docker Desktop updates itself).
import { ContainerAdapter, type ContainerInfo } from '../core/docker/containerAdapter';
import { findDockerCli } from '../core/docker/dockerCli';
import { systemClock, type Clock, type Logger, type ProcessRunner, type RunResult } from '../core/ports';
import type { MonitorDocker } from './monitorLoop';

/**
 * Upper limit for every Docker call of the monitor. `docker stop` gives the container 10 seconds before SIGKILL, so it
 * needs more than that. The limit keeps a tick short, so that the lock file of the monitor is refreshed long before it
 * counts as stale (MONITOR_LOCK_STALE_MS).
 */
export const MONITOR_DOCKER_TIMEOUT_MS = 30_000;
/** A missing Docker CLI is looked up again after this time. */
export const DOCKER_LOOKUP_RETRY_MS = 60_000;

/** A runner whose calls end after `capMs` at the latest, also when the caller asks for a longer or no time limit. */
export function capTimeout(runner: ProcessRunner, capMs: number): ProcessRunner {
  return {
    run: (file, args, options = {}) =>
      runner.run(file, args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? capMs, capMs) }),
  };
}

/**
 * Process environment for the Docker calls of the monitor: the environment of the monitor without
 * ELECTRON_RUN_AS_NODE, which only makes the VS Code executable run as Node.js and must not reach other programs.
 */
export function monitorDockerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete result[key];
  }
  return result;
}

export interface MonitorDockerOptions {
  runner: ProcessRunner;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  logger: Logger;
  clock?: Clock;
  /** Default: `findDockerCli`. */
  findDocker?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined;
  /** Default: MONITOR_DOCKER_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** MonitorDocker on the Docker CLI. Without a CLI, every call throws (the loop takes that as "Docker does not answer"). */
export class MonitorDockerClient implements MonitorDocker {
  private readonly runner: ProcessRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: Clock;
  private readonly findDocker: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined;
  private adapter: ContainerAdapter | undefined;
  private lookedUpAt: number | undefined;

  constructor(private readonly options: MonitorDockerOptions) {
    this.runner = capTimeout(options.runner, options.timeoutMs ?? MONITOR_DOCKER_TIMEOUT_MS);
    this.env = monitorDockerEnv(options.env);
    this.clock = options.clock ?? systemClock;
    this.findDocker = options.findDocker ?? findDockerCli;
  }

  listEnvironmentContainers(): Promise<ContainerInfo[]> {
    return this.current().listEnvironmentContainers();
  }

  exec(container: string, command: readonly string[], options: { user?: string; timeoutMs?: number }): Promise<RunResult> {
    return this.current().exec(container, command, options);
  }

  stopContainer(nameOrId: string): Promise<void> {
    return this.current().stopContainer(nameOrId);
  }

  private current(): ContainerAdapter {
    const now = this.clock.now();
    const stale = this.lookedUpAt === undefined || Math.abs(now - this.lookedUpAt) >= DOCKER_LOOKUP_RETRY_MS;
    if (!this.adapter || (!this.adapter.isInstalled() && stale)) {
      this.lookedUpAt = now;
      const dockerPath = this.findDocker(this.env, this.options.platform);
      this.adapter = new ContainerAdapter(this.runner, dockerPath, this.env, this.options.logger, this.options.platform);
      if (dockerPath) this.options.logger.info(`Docker CLI: ${dockerPath}`);
    }
    return this.adapter;
  }
}
