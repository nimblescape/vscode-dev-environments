// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (section 0 of the plan): the one registry of the scripts that run in a container, and the one primitive
// that runs them.
import { describe, expect, it } from 'vitest';
import { GIT_SUMMARY_SCRIPT } from '../git/gitSummary';
import { TOKEN_REMOVE_SCRIPT, TOKEN_WRITE_SCRIPT } from '../helper/containerToken';
import { SECRET_TOKEN } from '../helperChannel/protocol';
import { CONTAINER_SCRIPTS, runScript, scriptCommand, type ContainerScript } from './containerScripts';
import type { DockerEngine, EngineExecOptions } from './dockerEngine';

function fakeEngine() {
  const execs: { container: string; command: readonly string[]; options: EngineExecOptions }[] = [];
  const engine: DockerEngine = {
    container: async () => undefined,
    containers: async () => [],
    exec: async (container, command, options = {}) => {
      execs.push({ container, command, options });
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
    stop: async () => {},
    start: async () => {},
  };
  return { engine, execs };
}

describe('the registry of the scripts that run in a container (plan step 11B1)', () => {
  it('names the scripts that the flows run, each with the text that is written and reviewed where it belongs', () => {
    expect(Object.keys(CONTAINER_SCRIPTS).sort()).toEqual([
      'configOwnershipFix',
      'existingPaths',
      'gitSummary',
      'homeGitConfig',
      'ownershipFix',
      'tokenRemove',
      'tokenWrite',
    ]);
    expect(CONTAINER_SCRIPTS.tokenWrite.script).toBe(TOKEN_WRITE_SCRIPT);
    expect(CONTAINER_SCRIPTS.tokenRemove.script).toBe(TOKEN_REMOVE_SCRIPT);
    expect(CONTAINER_SCRIPTS.gitSummary.script).toBe(GIT_SUMMARY_SCRIPT);
  });

  it('gives the arguments as positional parameters, never as part of the script', () => {
    expect(scriptCommand('gitSummary', ['/workspaces/app'])).toEqual(['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', '/workspaces/app']);
    expect(scriptCommand('tokenRemove', [])).toEqual(['sh', '-c', TOKEN_REMOVE_SCRIPT, 'sh']);
    for (const name of Object.keys(CONTAINER_SCRIPTS) as ContainerScript[]) {
      const command = scriptCommand(name, ['a b', '$(whoami)']);
      expect(command.slice(-2), name).toEqual(['a b', '$(whoami)']);
      expect(command[2], name).toBe(CONTAINER_SCRIPTS[name].script);
    }
  });

  it('runs a script through the one primitive, and only the token script takes a secret', async () => {
    const { engine, execs } = fakeEngine();
    await runScript(engine, 'c1', 'gitSummary', ['/workspaces/app'], { user: 'dev', timeoutMs: 1_000 });
    await runScript(engine, 'c1', 'tokenWrite', ['dev', 'octocat'], { user: 'root' });
    expect(execs[0]).toMatchObject({ container: 'c1', command: scriptCommand('gitSummary', ['/workspaces/app']), options: { user: 'dev', timeoutMs: 1_000 } });
    expect(execs[0].options.secretInput).toBeUndefined();
    expect(execs[1].options.secretInput).toBe(SECRET_TOKEN);
    expect(JSON.stringify(execs)).not.toContain('"input"');
  });
});
