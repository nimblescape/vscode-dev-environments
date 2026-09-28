// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker host of an operation (unit 7). The current Docker context is read at the start of each operation
// (`docker context inspect`), never cached beyond it: a context switch while VS Code runs takes effect for the next
// operation. An operation keeps the host it started with: its Docker calls get DOCKER_CONTEXT with the name of the
// context that it read (ContainerAdapter.run), so a switch in the middle does not move half of it to another engine.
import { AsyncLocalStorage } from 'async_hooks';
import { errorMessage } from '../errors';
import type { Logger, RunOptions, RunResult } from '../ports';
import { envValue } from './dockerCli';
import { LOCAL_DOCKER_TARGET, dockerTargetOf, parseContextInspect, type DockerTarget } from './dockerHost';

/**
 * The target of an operation while it runs. Timers and listeners that an operation creates keep its store after it
 * ended (AsyncLocalStorage); `active` is false then, so they read the current context again.
 */
interface OperationScope {
  target: DockerTarget;
  active: boolean;
}

const operationTargets = new AsyncLocalStorage<OperationScope>();

/** The Docker target of the operation that runs now, if any. */
export function operationDockerTarget(): DockerTarget | undefined {
  const scope = operationTargets.getStore();
  return scope?.active ? scope.target : undefined;
}

/** Runs `fn` outside of any operation: its Docker calls read the current context themselves (attachDiagnostics.ts). */
export function outsideOperation<T>(fn: () => Promise<T>): Promise<T> {
  return operationTargets.exit(fn);
}

/** Runs `fn` as an operation on `target` (see the module comment). */
export async function runWithDockerTarget<T>(target: DockerTarget, fn: () => Promise<T>): Promise<T> {
  const scope: OperationScope = { target, active: true };
  try {
    return await operationTargets.run(scope, fn);
  } finally {
    scope.active = false;
  }
}

/** Time limit of `docker context inspect` (it reads only local files; the daemon is not asked). */
export const CONTEXT_INSPECT_TIMEOUT_MS = 15_000;

/** The part of ContainerAdapter that the resolver uses. */
export interface ContextReader {
  isInstalled(): boolean;
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

/** Reads the current Docker target, and runs operations with it. */
export class DockerTargets {
  private lastTarget: DockerTarget | undefined;
  private readonly listeners = new Set<(target: DockerTarget) => void>();
  /** Review of the sidebar host (S4): the number of the newest read that started, and of the newest one applied. */
  private readsStarted = 0;
  private readApplied = 0;

  constructor(
    private readonly docker: ContextReader,
    private readonly env: NodeJS.ProcessEnv,
    private readonly logger: Logger,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** The target of the last read, for synchronous callers (the Docker setup). Undefined before the first read. */
  get last(): DockerTarget | undefined {
    return this.lastTarget;
  }

  /**
   * Reads the current target now: DOCKER_HOST of VS Code's environment if set, else the current Docker context (which
   * DOCKER_CONTEXT may name). Without a Docker CLI, or when the context cannot be read, the local Docker (logged).
   * Never throws.
   */
  async resolve(): Promise<DockerTarget> {
    const read = ++this.readsStarted;
    const target = await this.read();
    // A read that started before a newer one finished (overlapping reads) does not overwrite what that one found.
    if (read < this.readApplied) return target;
    this.readApplied = read;
    this.lastTarget = target;
    for (const listener of [...this.listeners]) {
      try {
        listener(target);
      } catch (error) {
        this.logger.warn(`A listener of the Docker host failed: ${errorMessage(error)}`);
      }
    }
    return target;
  }

  /**
   * User request 2026-09-28 (the Docker host in the sidebar): `listener` gets every target that `resolve` reads, except
   * one of a read that a newer read overtook. Returns the function that removes it.
   */
  onDidResolve(listener: (target: DockerTarget) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The target of the running operation, or a fresh read outside of one. */
  async current(): Promise<DockerTarget> {
    return operationDockerTarget() ?? this.resolve();
  }

  /** The Docker host of `current()` ('' for the local Docker). */
  async host(): Promise<string> {
    return (await this.current()).host;
  }

  /**
   * Runs `fn` as one operation: the target is read once at its start (unless an operation runs already, whose target
   * `fn` keeps).
   */
  async withOperation<T>(fn: () => Promise<T>): Promise<T> {
    if (operationDockerTarget()) return fn();
    const target = await this.resolve();
    return runWithDockerTarget(target, fn);
  }

  private async read(): Promise<DockerTarget> {
    if (!this.docker.isInstalled()) return LOCAL_DOCKER_TARGET;
    const dockerHost = envValue(this.env, 'DOCKER_HOST', this.platform)?.trim();
    try {
      // With DOCKER_HOST set, the CLI inspects the context `default`, whose endpoint is DOCKER_HOST.
      const result = await this.docker.run(['context', 'inspect', '--format', '{{json .}}'], { timeoutMs: CONTEXT_INSPECT_TIMEOUT_MS });
      const parsed = result.exitCode === 0 ? parseContextInspect(result.stdout) : undefined;
      if (!parsed) {
        this.logger.warn(`The current Docker context could not be read. The local Docker is assumed: ${(result.stderr || result.stdout).trim()}`);
        return dockerHost ? dockerTargetOf(dockerHost, undefined) : LOCAL_DOCKER_TARGET;
      }
      return dockerTargetOf(dockerHost ? dockerHost : parsed.endpoint, dockerHost ? undefined : parsed.name);
    } catch (error) {
      this.logger.warn(`The current Docker context could not be read. The local Docker is assumed: ${errorMessage(error)}`);
      return dockerHost ? dockerTargetOf(dockerHost, undefined) : LOCAL_DOCKER_TARGET;
    }
  }
}
