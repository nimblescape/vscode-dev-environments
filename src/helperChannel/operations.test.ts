// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR A: the probe names the engine behind the socket of the worker.
import { describe, expect, it } from 'vitest';
import { parseProbeValue } from '../core/helperChannel/protocol';
import { probeOperation } from './operations';
import type { OperationContext } from './server';
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
