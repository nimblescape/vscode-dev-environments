// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR A: the probe names the engine behind the socket of the worker.
import { describe, expect, it } from 'vitest';
import { parseProbeValue, parseRefreshValue, parseWindowStateValue } from '../core/helperChannel/protocol';
import { ENV_API, EXPECTED_STATES, REFRESH_ENVIRONMENTS, fixtureEngine } from '../core/pipeline/refreshStates.testkit';
import { windowStateOperation } from './flowOperations';
import { probeOperation, refreshOperation } from './operations';
import { OperationError, type OperationContext } from './server';
import { contextSecrets } from './operationContext.testkit';

function context(answers: Record<string, { exitCode: number; stdout: string }>): { context: OperationContext; calls: string[][] } {
  const calls: string[][] = [];
  const value: OperationContext = {
    signal: new AbortController().signal,
    ...contextSecrets(),
    progress: () => {},
    log: () => {},
    output: () => {},
    docker: async (args) => {
      calls.push([...args]);
      const answer = answers[args[0]] ?? { exitCode: 1, stdout: '' };
      return { ...answer, stderr: answer.exitCode === 0 ? '' : 'failed', timedOut: false };
    },
  };
  return { context: value, calls };
}

describe('the probe operation (plan step 5, PR A)', () => {
  it('names the engine identity after the server version', async () => {
    const engine = '"7b1c:ABCD" "/var/lib/docker"';
    const { context: ctx, calls } = context({ version: { exitCode: 0, stdout: '27.1.0\n' }, info: { exitCode: 0, stdout: `${engine}\n` } });
    const value = parseProbeValue(await probeOperation({}, ctx));
    expect(value).toEqual({ serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine });
    expect(calls).toEqual([
      ['version', '--format', '{{.Server.Version}}'],
      ['info', '--format', '{{json .ID}} {{json .DockerRootDir}}'],
    ]);
  });

  it('names no engine when docker info fails or prints something else', async () => {
    for (const info of [{ exitCode: 1, stdout: '' }, { exitCode: 0, stdout: '"" "/var/lib/docker"' }, { exitCode: 0, stdout: 'garbage' }]) {
      const { context: ctx } = context({ version: { exitCode: 0, stdout: '27.1.0\n' }, info });
      expect(parseProbeValue(await probeOperation({}, ctx))).toEqual({ serverVersion: '27.1.0', detail: 'Docker 27.1.0' });
    }
  });

  it('does not ask for the engine when docker version fails', async () => {
    const { context: ctx, calls } = context({});
    expect(parseProbeValue(await probeOperation({}, ctx))).toEqual({ detail: 'failed' });
    expect(calls).toHaveLength(1);
  });
});

// Plan step 11C1, review round 1 (B-R1-1, B-R1-2): the operations of the window reads and of the refresh, over the port of
// the engine (EngineDocker).
describe('the operations windowState and refresh over the port of the engine (plan step 11C1)', () => {
  function engineContext(secrets: Record<string, string> = {}): { context: OperationContext; progress: string[]; controller: AbortController } {
    const progress: string[] = [];
    const controller = new AbortController();
    const value: OperationContext = {
      signal: controller.signal,
      ...contextSecrets(secrets),
      progress: (step) => progress.push(step),
      log: () => {},
      output: () => {},
      docker: async () => {
        throw new Error('The operation runs no Docker CLI call.');
      },
    };
    return { context: value, progress, controller };
  }

  const PARAMS = { environmentId: ENV_API, containerName: 'devenv-api', checks: 'on', branch: { folder: '/workspaces/api', user: 'node' } };

  it('refresh: the states and branches of the fixture, with its progress', async () => {
    const { engine } = fixtureEngine();
    const { context: ctx, progress } = engineContext();
    const value = parseRefreshValue(await refreshOperation(() => engine)({ environments: REFRESH_ENVIRONMENTS }, ctx), { environments: REFRESH_ENVIRONMENTS });
    expect(value).toEqual(EXPECTED_STATES);
    expect(progress).toEqual(['refresh']);
  });

  it('windowState: the state and branch of the container, the signal of the operation passed to the read of the branch', async () => {
    const { engine, execs } = fixtureEngine();
    const { context: ctx } = engineContext();
    expect(parseWindowStateValue(await windowStateOperation(() => engine)(PARAMS, ctx))).toEqual({ state: 'running', outdated: 'version', branch: 'feature/x' });
    expect(execs).toEqual([{ container: 'devenv-api', user: 'node', signal: ctx.signal }]);
  });

  it('windowState: invalid parameters or a secret are invalid, before the engine is asked; the secret is not echoed', async () => {
    let asked = 0;
    const engineOf = () => {
      asked++;
      return fixtureEngine().engine;
    };
    for (const [params, secrets] of [
      [{ ...PARAMS, containerName: '-x' }, {}],
      [PARAMS, { token: 'ghs_secretvalue' }],
    ] as const) {
      const error = await windowStateOperation(engineOf)(params, engineContext(secrets).context).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(OperationError);
      expect(error).toMatchObject({ code: 'invalid' });
      expect(String((error as Error).message)).not.toContain('ghs_secretvalue');
    }
    expect(asked).toBe(0);
  });

  it('windowState: an engine that fails is `failed` (never a state), a cancel is `cancelled`', async () => {
    const failing = { ...fixtureEngine().engine, container: async () => Promise.reject(new Error('socket closed')), containers: async () => Promise.reject(new Error('socket closed')) };
    const { context: ctx, controller } = engineContext();
    await expect(windowStateOperation(() => failing)(PARAMS, ctx)).rejects.toMatchObject({ code: 'failed' });
    controller.abort();
    await expect(windowStateOperation(() => failing)(PARAMS, ctx)).rejects.toMatchObject({ code: 'cancelled' });
  });
});
