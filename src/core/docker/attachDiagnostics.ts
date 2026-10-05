// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Log lines for the attach of a window (user request 2026-09-28): before the window switches to the container, and when
// the attached window activates, the log shows which Docker the Dev Containers extension will ask. Its first
// `docker inspect` names no context, so it follows DOCKER_HOST, DOCKER_CONTEXT, or the current context; the calls of
// this extension name the context of their operation. The lines show both, and whether each one finds the container.
// Read-only Docker calls; never throws. No `vscode`.
import { errorMessage } from '../errors';
import type { RunOptions, RunResult } from '../ports';
import { envValue } from './dockerCli';
import { outsideOperation } from './dockerTargets';

/** Time limit of each call (context reads are local files; an inspect may go over SSH). */
export const ATTACH_DIAGNOSTICS_TIMEOUT_MS = 15_000;

/** The part of BootstrapDocker that the diagnostics use. */
export interface DiagnosticsDocker {
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

async function answer(docker: DiagnosticsDocker, args: readonly string[]): Promise<string> {
  try {
    const result = await outsideOperation(() => docker.run(args, { timeoutMs: ATTACH_DIAGNOSTICS_TIMEOUT_MS }));
    const text = (result.exitCode === 0 ? result.stdout : result.stderr || result.stdout).trim().replace(/\s+/g, ' ');
    return result.exitCode === 0 ? text || '(empty)' : `failed (exit code ${result.exitCode}): ${text}`;
  } catch (error) {
    return `failed: ${errorMessage(error)}`;
  }
}

function inspectArgs(containerName: string, context?: string): string[] {
  const name = containerName.startsWith('/') ? containerName : `/${containerName}`;
  const prefix = context === undefined ? [] : ['--context', context];
  return [...prefix, 'inspect', '--type', 'container', name, '--format', '{{.Id}} {{.State.Status}}'];
}

/**
 * The lines about the Docker of an attach to `containerName`. `environmentContext` is the Docker context that the
 * operation of the environment used (review round 1, F4), or undefined for none named (the local Docker, DOCKER_HOST).
 * `env` is the environment of VS Code's Docker calls.
 */
export async function attachDiagnostics(
  docker: DiagnosticsDocker,
  env: NodeJS.ProcessEnv,
  containerName: string,
  environmentContext: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const dockerHost = envValue(env, 'DOCKER_HOST', platform)?.trim();
  const dockerContext = envValue(env, 'DOCKER_CONTEXT', platform)?.trim();
  const current = await answer(docker, ['context', 'show']);
  const currentEndpoint = await answer(docker, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  const lines = [
    `DOCKER_HOST: ${dockerHost ? dockerHost : 'not set'}; DOCKER_CONTEXT: ${dockerContext ? dockerContext : 'not set'}.`,
    `Current Docker context: ${current}, endpoint ${currentEndpoint}.`,
    `Docker context of the environment: ${environmentContext ?? 'none named'}.`,
    `Inspect of ${containerName} without a context (as the first call of Dev Containers): ${await answer(docker, inspectArgs(containerName))}.`,
  ];
  if (environmentContext !== undefined) {
    lines.push(`Inspect of ${containerName} with the context ${environmentContext}: ${await answer(docker, inspectArgs(containerName, environmentContext))}.`);
  }
  return lines;
}
