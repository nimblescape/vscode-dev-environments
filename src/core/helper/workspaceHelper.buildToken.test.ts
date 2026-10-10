// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #139 (A-L3): `devcontainer build` runs with the token of the open as a known secret, like `up`
// and run-user-commands: the step of the batch helper gets it (only masked there), and WorkspaceHelper masks it in each
// stream on its own and in the error, also when a stream splits it around a chunk of the other stream.
import { describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { SECRET_TOKEN } from '../helperChannel/protocol';
import type { Logger, RunResult } from '../ports';
import { runWithBatchScope } from './batchScope';
import type { BatchStepKind } from './batchStepKinds';
import { DevcontainerCommandError } from './devcontainerCli';
import { WorkspaceHelper } from './workspaceHelper';

const TOKEN = 'gho_0123456789abcdefBUILDtoken';
const RESULT = '{"outcome":"success","imageName":"devenv-x:1"}\n';

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

function build(script: Script, output: string[]) {
  const helper = new WorkspaceHelper({ logger: silent, ownImage: { tag: 'devenv-helper:own', id: `sha256:${'b'.repeat(64)}` }, socket: '/var/run/docker.sock', containerRuns: async () => true });
  return runWithBatchScope(lockOf(script), 'vol', silent, () =>
    helper.build({ volumeName: 'vol', repository: 'acme/api', configPath: '.devcontainer/devcontainer.json', imageName: 'devenv-x:1', token: TOKEN, onOutput: (text) => output.push(text) }),
  );
}

describe('devcontainer build masks the token of the open (review round 1 of PR #139, A-L3)', () => {
  it('the step gets the token as its secret; a token split on stderr around a stdout chunk never appears', async () => {
    const secrets: Array<Record<string, string> | undefined> = [];
    const output: string[] = [];
    const result = await build((_kind, options) => {
      secrets.push(options.secrets);
      options.onOutput?.('stderr', `#5 GH_TOKEN=${TOKEN.slice(0, 9)}`);
      options.onOutput?.('stdout', 'progress line\n');
      options.onOutput?.('stderr', `${TOKEN.slice(9)} done\n`);
      options.onOutput?.('stdout', RESULT);
      return { stdout: `progress line\n${RESULT}`, stderr: `#5 GH_TOKEN=${TOKEN} done\n` };
    }, output);
    expect(result).toEqual({ outcome: 'success', imageName: 'devenv-x:1' });
    expect(secrets).toEqual([{ [SECRET_TOKEN]: TOKEN }]);
    const text = output.join('');
    expect(text).not.toContain(TOKEN.slice(0, 9));
    expect(text).not.toContain(TOKEN.slice(9));
    expect(text).toBe('#5 GH_TOKEN=progress line\n*** done\n');
  });

  it('a failed build: the token is masked in both texts of its error', async () => {
    const error = await build(() => ({ exitCode: 1, stdout: `out ${TOKEN}\n`, stderr: `err ${TOKEN}\n` }), []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevcontainerCommandError);
    const failed = error as DevcontainerCommandError;
    expect(failed.stdout).toBe('out ***\n');
    expect(failed.stderr).toBe('err ***\n');
    expect(failed.message).not.toContain(TOKEN);
  });
});
