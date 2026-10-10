// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11 (PR #138, B1, one function per fact): readGitSummary, the one read of the Git state of a
// running dev container, for Stop (cancel `throw`) and the service (cancel `fail`).
import { describe, expect, it } from 'vitest';
import { abortError } from '../ports';
import { scriptCommand, type ScriptExec } from '../worker/containerScripts';
import type { EngineExecResult } from '../worker/dockerEngine';
import { GIT_SUMMARY_TIMEOUT_MS, readGitSummary } from './refreshStates';

const CONTAINER = { id: 'c'.repeat(64), name: 'devenv-acme-api-brave-noether' };
const NOW = '2026-10-10T12:00:00.000Z';

function exec(answer: () => Partial<EngineExecResult> | Promise<never>): { docker: ScriptExec; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    docker: {
      exec: async (container, command, options) => {
        calls.push([container, command, options]);
        const value = await answer();
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...value };
      },
    },
  };
}

function read(docker: ScriptExec, cancel: 'throw' | 'fail', signal?: AbortSignal): { result: ReturnType<typeof readGitSummary>; lines: string[] } {
  const lines: string[] = [];
  return { result: readGitSummary(docker, CONTAINER, 'vscode', '/workspaces/api', { now: () => NOW, log: (line) => lines.push(line), cancel, signal }), lines };
}

describe('readGitSummary (PR #138, B1)', () => {
  it('runs the script gitSummary in the container by its ID, as the user, within 30 s and with the signal, and parses it at now()', async () => {
    const { docker, calls } = exec(() => ({ stdout: 'feature-z\n5\n6\n2\n' }));
    const signal = new AbortController().signal;
    const { result, lines } = read(docker, 'fail', signal);
    expect(await result).toEqual({ branch: 'feature-z', uncommittedFiles: 5, unpushedCommits: 6, stashes: 2, recordedAt: NOW });
    expect(calls).toEqual([[CONTAINER.id, scriptCommand('gitSummary', ['/workspaces/api']), { user: 'vscode', timeoutMs: GIT_SUMMARY_TIMEOUT_MS, signal }]]);
    expect(GIT_SUMMARY_TIMEOUT_MS).toBe(30_000);
    expect(lines).toEqual([]);
  });

  it('names the reason of a failed script by the container name: the time limit, its output (trimmed), or its exit code', async () => {
    for (const [answer, reason] of [
      [{ exitCode: null, stdout: 'partial', timedOut: true }, 'the script did not end in time.'],
      [{ exitCode: 1, stderr: ' fatal: not a git repository \n', stdout: 'ignored' }, 'fatal: not a git repository'],
      [{ exitCode: 1, stdout: '  only on stdout \n' }, 'only on stdout'],
      [{ exitCode: 127 }, 'exit code 127.'],
    ] as const) {
      const { result, lines } = read(exec(() => answer).docker, 'throw');
      expect(await result).toBeUndefined();
      expect(lines).toEqual([`The Git state in ${CONTAINER.name} could not be read: ${reason}`]);
    }
  });

  it('a failure that throws is a failed read with its message for both callers, unless the signal aborted', async () => {
    for (const cancel of ['throw', 'fail'] as const) {
      const { result, lines } = read(exec(() => Promise.reject(new Error('socket hang up'))).docker, cancel, new AbortController().signal);
      expect(await result).toBeUndefined();
      expect(lines).toEqual([`The Git state in ${CONTAINER.name} could not be read: socket hang up`]);
    }
  });

  it('a cancel throws with `throw` (Stop), and is a failed read with `fail` (the service)', async () => {
    const controller = new AbortController();
    controller.abort();
    const thrown = read(exec(() => Promise.reject(abortError())).docker, 'throw', controller.signal);
    await expect(thrown.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(thrown.lines).toEqual([]);
    const failed = read(exec(() => Promise.reject(abortError())).docker, 'fail', controller.signal);
    expect(await failed.result).toBeUndefined();
    expect(failed.lines).toEqual([`The Git state in ${CONTAINER.name} could not be read: The operation was cancelled.`]);
  });
});
