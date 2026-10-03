// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../ports';
import { attachDiagnostics } from './attachDiagnostics';
import { dockerTargetOf, remoteContextNames } from './dockerHost';
import { operationDockerTarget, runWithDockerTarget } from './dockerTargets';

const NAME = 'devenv-acme-api-a1b2c3d4';
// User decisions 2026-10-03: the Docker context of a host is named after it (remoteContextNames; before: remoteContextName).
const CONTEXT = remoteContextNames('build-box')[0];

function ok(stdout: string): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

/** A Docker CLI that records each call with the context of the operation it ran in. */
function fakeDocker(answers: (args: readonly string[]) => RunResult | Error) {
  const calls: { args: string; operationContext: string | undefined; timeoutMs: number | undefined }[] = [];
  return {
    calls,
    run: async (args: readonly string[], options?: RunOptions): Promise<RunResult> => {
      calls.push({ args: args.join(' '), operationContext: operationDockerTarget()?.context, timeoutMs: options?.timeoutMs });
      const answer = answers(args);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe('attachDiagnostics (user request 2026-09-28)', () => {
  it('reports the variables, the current context, and both inspects of a remote environment', async () => {
    const docker = fakeDocker((args) => {
      const text = args.join(' ');
      if (text === 'context show') return ok('machines\n');
      if (text.startsWith('context inspect')) return ok('ssh://machines\n');
      if (text.startsWith('--context')) return ok('abc123 running\n');
      return { exitCode: 1, stdout: '', stderr: `Error: No such container: /${NAME}\n`, timedOut: false };
    });
    const lines = await attachDiagnostics(docker, { DOCKER_CONTEXT: 'x' }, NAME, CONTEXT, 'linux');
    expect(lines).toEqual([
      'DOCKER_HOST: not set; DOCKER_CONTEXT: x.',
      'Current Docker context: machines, endpoint ssh://machines.',
      `Docker context of the environment: ${CONTEXT}.`,
      `Inspect of ${NAME} without a context (as the first call of Dev Containers): failed (exit code 1): Error: No such container: /${NAME}.`,
      `Inspect of ${NAME} with the context ${CONTEXT}: abc123 running.`,
    ]);
    expect(docker.calls.map((call) => call.args)).toEqual([
      'context show',
      'context inspect --format {{.Endpoints.docker.Host}}',
      `inspect --type container /${NAME} --format {{.Id}} {{.State.Status}}`,
      `--context ${CONTEXT} inspect --type container /${NAME} --format {{.Id}} {{.State.Status}}`,
    ]);
    expect(docker.calls.every((call) => call.timeoutMs !== undefined)).toBe(true);
  });

  // Review round 1 (F4): the caller passes the context of the operation; none for the local Docker or DOCKER_HOST.
  it('names no context for the local Docker and inspects once', async () => {
    const docker = fakeDocker((args) => (args[0] === 'inspect' ? ok('abc123 running') : ok('default')));
    const lines = await attachDiagnostics(docker, { DOCKER_HOST: 'unix:///var/run/docker.sock' }, `/${NAME}`, undefined, 'linux');
    expect(lines[0]).toBe('DOCKER_HOST: unix:///var/run/docker.sock; DOCKER_CONTEXT: not set.');
    expect(lines[2]).toBe('Docker context of the environment: none named.');
    expect(lines).toHaveLength(4);
    expect(docker.calls.filter((call) => call.args.includes('inspect --type container'))).toHaveLength(1);
  });

  it('runs its calls outside of the operation, so they are not pinned to its context', async () => {
    const docker = fakeDocker(() => ok(''));
    await runWithDockerTarget(dockerTargetOf('ssh://build-box', CONTEXT), () => attachDiagnostics(docker, {}, NAME, CONTEXT, 'linux'));
    expect(docker.calls.map((call) => call.operationContext)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('never throws: a failing call becomes a line', async () => {
    const docker = fakeDocker(() => new Error('spawn docker ENOENT'));
    const lines = await attachDiagnostics(docker, {}, NAME, undefined, 'linux');
    expect(lines[1]).toBe('Current Docker context: failed: spawn docker ENOENT, endpoint failed: spawn docker ENOENT.');
    expect(lines[3]).toContain('failed: spawn docker ENOENT');
  });
});
