// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup PR #139 (B, mutation probes): WorkspaceHelper masks each stream of a step (stdout, stderr) with
// its own StreamRedactor, so a token that one stream splits across two chunks is masked also when a chunk of the other
// stream comes between them (the clone, up and run-user-commands); the clone flushes both streams at their end, also
// when the step throws, and masks the token in both texts of its CommandError.
import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { abortError, type Logger, type RunResult } from '../ports';
import { runWithBatchScope } from './batchScope';
import type { BatchStepKind } from './batchStepKinds';
import { WorkspaceHelper } from './workspaceHelper';

const TOKEN = 'gho_0123456789abcdefPROBEtoken';
const RESULT = '{"outcome":"success","containerId":"c0ffee"}\n';

type Script = (kind: BatchStepKind, options: BatchStepOptions) => Partial<RunResult>;

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {}, output: () => {} };

/** A lock whose batch helper runs each step as `script` (its output through options.onOutput). */
function lockOf(script: Script): HeldEnvironmentLock {
  return {
    environmentId: 'e',
    lost: new Promise<string>(() => {}),
    release: async () => {},
    batch: async (): Promise<HelperBatchSession> => ({
      session: 's1',
      lost: new Promise<string>(() => {}),
      step: async (kind, _params, options = {}) => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...script(kind, options) }),
      close: async () => {},
    }),
  };
}

function helper(): WorkspaceHelper {
  return new WorkspaceHelper({ logger: silent, ownImage: { tag: 'devenv-helper:own', id: `sha256:${'b'.repeat(64)}` }, socket: '/var/run/docker.sock', containerRuns: async () => true });
}

/** The clone with the batch helper running `script`, its output into `output`. */
const clone = (script: Script, output: string[]) =>
  runWithBatchScope(lockOf(script), 'vol', silent, () => helper().clone({ volumeName: 'vol', repository: 'acme/api', token: TOKEN, onOutput: (text) => output.push(text) }));

/** stdout: `x <start of the token>`, then a whole stderr line, then the rest of the token on stdout. */
function interleaved(tail: string): Script {
  return (_kind, options) => {
    options.onOutput?.('stdout', `x ${TOKEN.slice(0, 8)}`);
    options.onOutput?.('stderr', 'warn: other stream\n');
    options.onOutput?.('stdout', `${TOKEN.slice(8)} y\n${tail}`);
    return { stdout: `x ${TOKEN} y\n${tail}`, stderr: 'warn: other stream\n' };
  };
}

describe('WorkspaceHelper masks each stream on its own (review round 1 of PR #139, B)', () => {
  it('the clone: a token split on stdout around a chunk of stderr never appears', async () => {
    const output: string[] = [];
    await clone(interleaved(''), output);
    const text = output.join('');
    expect(text).not.toContain(TOKEN.slice(0, 8));
    expect(text).not.toContain(TOKEN.slice(8));
    expect(text).toBe('x warn: other stream\n*** y\n');
  });

  it('run-user-commands: a token split on stdout around a chunk of stderr never appears', async () => {
    const output: string[] = [];
    await runWithBatchScope(lockOf(interleaved(RESULT)), 'vol', silent, () =>
      helper().runUserCommands({
        volumeName: 'vol',
        repository: 'acme/api',
        override: {},
        environmentId: 'e',
        containerId: 'c0ffee',
        token: TOKEN,
        onOutput: (text) => output.push(text),
      }),
    );
    const text = output.join('');
    expect(text).not.toContain(TOKEN.slice(0, 8));
    expect(text).not.toContain(TOKEN.slice(8));
    expect(text).toContain('x *** y\n');
  });
});

/** stderr: `e <start of the token>`, then a whole stdout line, then the rest of the token on stderr. */
function interleavedStderr(result: string): Script {
  return (_kind, options) => {
    options.onOutput?.('stderr', `e ${TOKEN.slice(0, 8)}`);
    options.onOutput?.('stdout', 'step line\n');
    options.onOutput?.('stderr', `${TOKEN.slice(8)} f\n`);
    if (result !== '') options.onOutput?.('stdout', result);
    return { stdout: `step line\n${result}`, stderr: `e ${TOKEN} f\n` };
  };
}

describe('up and run-user-commands mask stderr on its own (review round 1 of PR #139, B)', () => {
  it('run-user-commands: a token split on stderr around a line of stdout never appears', async () => {
    const output: string[] = [];
    await runWithBatchScope(lockOf(interleavedStderr(RESULT)), 'vol', silent, () =>
      helper().runUserCommands({ volumeName: 'vol', repository: 'acme/api', override: {}, environmentId: 'e', containerId: 'c0ffee', token: TOKEN, onOutput: (text) => output.push(text) }),
    );
    expect(output.join('')).toBe('e step line\n*** f\n');
  });

  it('up: a token split on stderr around a line of stdout never appears', async () => {
    const output: string[] = [];
    await runWithBatchScope(lockOf(interleavedStderr(RESULT)), 'vol', silent, () =>
      helper().up({ volumeName: 'vol', repository: 'acme/api', override: {}, environmentId: 'e', removeExistingContainer: false, token: TOKEN, onOutput: (text) => output.push(text) }),
    );
    expect(output.join('')).toBe('e step line\n*** f\n');
  });

  it('the clone: a token split on stderr around a chunk of stdout never appears', async () => {
    const output: string[] = [];
    await clone(interleavedStderr(''), output);
    expect(output.join('')).toBe('e step line\n*** f\n');
  });
});

describe('the clone: the end of each stream and the failure text (review round 1 of PR #139, B)', () => {
  it('flushes the end of stderr: a cut token start as ***, a short rest as it is', async () => {
    const output: string[] = [];
    await clone((_kind, options) => {
      options.onOutput?.('stderr', `fatal: cut ${TOKEN.slice(0, 9)}`);
      return { stderr: `fatal: cut ${TOKEN.slice(0, 9)}` };
    }, output);
    expect(output.join('')).toBe('fatal: cut ***');
    const short: string[] = [];
    await clone((_kind, options) => {
      options.onOutput?.('stderr', 'done g');
      return { stderr: 'done g' };
    }, short);
    expect(short.join('')).toBe('done g');
  });

  it('flushes both streams also when the step throws (a cancel)', async () => {
    const output: string[] = [];
    const error = await clone((_kind, options) => {
      options.onOutput?.('stdout', `out ${TOKEN.slice(0, 6)}`);
      options.onOutput?.('stderr', `err ${TOKEN.slice(0, 7)}`);
      throw abortError();
    }, output).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'AbortError' });
    // Each stream holds back the start of the token until the end, then flushes it masked.
    expect(output.join('')).toBe('out err ******');
  });

  it('masks the token in the stdout and the stderr of the CommandError of a failed clone', async () => {
    const output: string[] = [];
    const error = await clone(() => ({ exitCode: 128, stdout: `out ${TOKEN}\n`, stderr: `err ${TOKEN}\n` }), output).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandError);
    const failure = error as CommandError;
    expect(failure.stdout).toBe('out ***\n');
    expect(failure.stderr).toBe('err ***\n');
    expect(failure.message).not.toContain(TOKEN);
  });
});
