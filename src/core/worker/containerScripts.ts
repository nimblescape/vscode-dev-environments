// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (section 0 of the plan, one concept for commanding Docker): the one registry of the scripts that run in
// a container. Every script of the flows is an entry here, with its typed arguments; a flow names the entry and its
// arguments and never builds a command of its own, and every entry runs through the one primitive `DockerEngine.exec`
// (runScript). The scripts themselves stay where they are written and reviewed (containerToken.ts, gitSummary.ts,
// containerGit.ts); this module only names them. No I/O, no `vscode`.
import { EXISTING_PATHS_SCRIPT, GIT_SUMMARY_SCRIPT, OWNERSHIP_FIX_SCRIPT } from '../git/gitSummary';
import { HOME_GIT_CONFIG_SCRIPT } from '../helper/containerGit';
import { TOKEN_REMOVE_SCRIPT, TOKEN_WRITE_SCRIPT } from '../helper/containerToken';
import { SECRET_TOKEN } from '../helperChannel/protocol';
import type { DockerEngine, EngineExecOptions, EngineExecResult } from './dockerEngine';

/** How a script runs: its text, whether it takes the token on its standard input, and the user when it is fixed. */
interface ScriptEntry {
  /** The program that runs the script: `sh -c <script> sh <args…>`, or `node -e <script> <args…>`. */
  program: 'sh' | 'node';
  script: string;
  /** The secret that is its standard input (plan step 11A: never an argument, never a log line). */
  secretInputName?: typeof SECRET_TOKEN;
}

/**
 * The scripts that the flows run in a container. A new script of a flow is added here, never built at a call site
 * (section 0 of the plan). The names are those of the flows that run them.
 */
export const CONTAINER_SCRIPTS = {
  /** Writes the GitHub token into the tmpfs of the dev container (its standard input is the token). */
  tokenWrite: { program: 'sh', script: TOKEN_WRITE_SCRIPT, secretInputName: SECRET_TOKEN },
  /** Empties the token folder of the dev container. */
  tokenRemove: { program: 'sh', script: TOKEN_REMOVE_SCRIPT },
  /** The Git state of the repository folder (branch, changed files, unpushed commits, stashes). */
  gitSummary: { program: 'sh', script: GIT_SUMMARY_SCRIPT },
  /** The `.gitconfig` in the home folder of the remote user. */
  homeGitConfig: { program: 'sh', script: HOME_GIT_CONFIG_SCRIPT },
  /** Gives the files of the repository folder to the remote user. */
  ownershipFix: { program: 'sh', script: OWNERSHIP_FIX_SCRIPT },
  /** Of the paths that it gets, the ones that exist. */
  existingPaths: { program: 'sh', script: EXISTING_PATHS_SCRIPT },
} as const satisfies Record<string, ScriptEntry>;

/** The name of a script of the registry. */
export type ContainerScript = keyof typeof CONTAINER_SCRIPTS;

/** The command of the script `name` with the arguments `args` (positional parameters, never part of the script text). */
export function scriptCommand(name: ContainerScript, args: readonly string[]): string[] {
  const entry: ScriptEntry = CONTAINER_SCRIPTS[name];
  return entry.program === 'sh' ? ['sh', '-c', entry.script, 'sh', ...args] : ['node', '-e', entry.script, ...args];
}

/**
 * Plan step 11B1: runs the script `name` in the container through the one primitive of the port. Its arguments are
 * positional parameters; a script that takes a secret gets it as the standard input of the process (never an argument).
 */
export async function runScript(
  engine: DockerEngine,
  container: string,
  name: ContainerScript,
  args: readonly string[],
  options: Omit<EngineExecOptions, 'input' | 'secretInputName'> = {},
): Promise<EngineExecResult> {
  const entry: ScriptEntry = CONTAINER_SCRIPTS[name];
  return engine.exec(container, scriptCommand(name, args), {
    ...options,
    ...(entry.secretInputName !== undefined ? { secretInputName: entry.secretInputName } : {}),
  });
}
