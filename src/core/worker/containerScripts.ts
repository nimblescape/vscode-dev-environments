// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (section 0 of the plan, one concept for commanding Docker): the one registry of the scripts that run in
// a container. Every script of the flows is an entry here, with its typed arguments; a flow names the entry and its
// arguments and never builds a command of its own, and every entry runs through the one primitive `DockerEngine.exec`
// (runScript). The scripts themselves stay where they are written and reviewed (containerToken.ts, gitSummary.ts,
// containerGit.ts); this module only names them. No I/O, no `vscode`. Plan step 11I (PR B, the former 11E5): every
// command of the pipeline in a container is an entry too (the checks and reads that are a program of the container
// itself are entries of their own kind, `command`), and runScript takes the `exec` that its caller has: the worker's
// engine (DockerEngine) or the pipeline's Docker (EnvironmentDocker, which EngineDocker serves over that engine). Plan
// step 11I (U2, decision of 2026-10-08): the commands that the worker runs in the Session Monitor container
// (monitorFlow.ts) are entries too; two of them read a plain standard input of their caller (`plainInput`).
import { EXISTING_PATHS_SCRIPT, GIT_BRANCH_SCRIPT, GIT_SUMMARY_SCRIPT, OWNERSHIP_FIX_SCRIPT } from '../git/gitSummary';
import { HOME_GIT_CONFIG_SCRIPT } from '../helper/containerGit';
import { TOKEN_REMOVE_SCRIPT, TOKEN_WRITE_SCRIPT } from '../helper/containerToken';
import { SECRET_TOKEN } from '../helperChannel/protocol';
import { REMOTE_MONITOR_SCRIPT_PATH, underRecordsLock } from '../remoteMonitor/protocol';
import type { EngineExecOptions, EngineExecResult } from './dockerEngine';
import { VSCODE_EXTENSION_SEED_SCRIPT } from './vscodeExtensionSeed';
import { VSCODE_SERVER_LINK_SCRIPT, VSCODE_SERVER_PRESENT_SCRIPT } from './vscodeServerLink';

/**
 * How a script runs. A script for a program of the container: its text, whether it takes the token on its standard
 * input, and its program. Plan step 11I (PR B): or a program of the container itself with its fixed arguments
 * (`command`), run without a shell as the call site ran it before. Review round 1 of PR #126 (F3): a secret input and a
 * plain input exclude each other in the type (each kind declares the other's field as `never`), so no entry has both.
 */
export type ScriptEntry =
  | {
      /** The program that runs the script: `sh -c <script> sh <args…>`. */
      program: 'sh';
      script: string;
      /** The secret that is its standard input (plan step 11A: never an argument, never a log line). */
      secretInputName?: typeof SECRET_TOKEN;
      /** Review round 1 of PR #126 (F3): a script takes no plain input. */
      plainInput?: never;
    }
  | {
      /** The program and its fixed arguments: `<command…> <args…>`. */
      command: readonly string[];
      /**
       * Plan step 11I (U2, decision of 2026-10-08): the program reads a plain standard input that its caller gives (JSON,
       * never a secret). runScript gives an input only to an entry with this, and refuses one for any other entry.
       */
      plainInput?: true;
      /** Review round 1 of PR #126 (F3): a program of the container takes no secret. */
      secretInputName?: never;
    };

/**
 * The scripts that the flows run in a container. A new script of a flow is added here, never built at a call site
 * (section 0 of the plan). The names are those of the flows that run them, or of what they do.
 */
export const CONTAINER_SCRIPTS = {
  /** Writes the GitHub token into the tmpfs of the dev container (its standard input is the token). */
  tokenWrite: { program: 'sh', script: TOKEN_WRITE_SCRIPT, secretInputName: SECRET_TOKEN },
  /** Empties the token folder of the dev container. */
  tokenRemove: { program: 'sh', script: TOKEN_REMOVE_SCRIPT },
  /** The Git state of the repository folder (branch, changed files, unpushed commits, stashes). */
  gitSummary: { program: 'sh', script: GIT_SUMMARY_SCRIPT },
  /**
   * Plan step 11I (PR B): the branch of the repository folder, read as the Git state reads it (GIT_BRANCH_FUNCTION of
   * gitSummary.ts, with its hardening and its fallback for Git before 2.22).
   */
  branch: { program: 'sh', script: GIT_BRANCH_SCRIPT },
  /** The `.gitconfig` in the home folder of the remote user. */
  homeGitConfig: { program: 'sh', script: HOME_GIT_CONFIG_SCRIPT },
  /** Gives the files of the repository folder to the remote user. */
  ownershipFix: { program: 'sh', script: OWNERSHIP_FIX_SCRIPT },
  /** Of the paths that it gets, the ones that exist. */
  existingPaths: { program: 'sh', script: EXISTING_PATHS_SCRIPT },
  /**
   * Plan step 11I (PR B): the recreate offer's check that the shell, which the Dev Container CLI and the Dev Containers
   * extension need, starts as the user (`docker exec -u` fails when /etc/passwd lacks the user).
   */
  check: { command: ['/bin/sh', '-c', 'exit 0'] },
  /** Plan step 11I (PR B): the version of Git in the container (containerGitSupport). */
  gitVersion: { command: ['git', '--version'] },
  /** Plan step 11I (PR B): the mounts of the container as its kernel shows them (verifiedIdentityTargets). */
  mountInfo: { command: ['cat', '/proc/self/mountinfo'] },
  /** Plan step 11I (PR B): the numeric user ID of the user that it gets. */
  userId: { command: ['id', '-u'] },
  /** Plan step 11I (PR B): the numeric ID of the primary group of the user that it gets. */
  groupId: { command: ['id', '-g'] },
  /** Plan step 11I (PR B): the hash of the script that the Session Monitor container stored (MonitorEngine.storedScript). */
  monitorScriptHash: { command: ['sha256sum', REMOTE_MONITOR_SCRIPT_PATH] },
  /**
   * Plan step 11I (U2, decision of 2026-10-08): a heartbeat of a window, in the Session Monitor container (its argument:
   * the heartbeat as one JSON argument), under the lock of the records (underRecordsLock), as heartbeatCommand of
   * src/core/remoteMonitor/protocol.ts built it before.
   */
  monitorHeartbeat: { command: underRecordsLock(['node', REMOTE_MONITOR_SCRIPT_PATH, 'heartbeat']) },
  /**
   * Plan step 11I (U2): Delete's removal of the record of a computer (its arguments: the source and the environment ID),
   * under the lock of the records, as forgetCommand built it before.
   */
  monitorForget: { command: underRecordsLock(['node', REMOTE_MONITOR_SCRIPT_PATH, 'forget']) },
  /** Plan step 11I (U2): stores the image settings of its plain standard input (JSON), as imageSettingsCommand built it. */
  monitorSettings: { command: ['node', REMOTE_MONITOR_SCRIPT_PATH, 'settings', '-'], plainInput: true },
  /** Plan step 11I (U2): stores the image list of its plain standard input (JSON), as imagesCommand built it. */
  monitorImages: { command: ['node', REMOTE_MONITOR_SCRIPT_PATH, 'images', '-'], plainInput: true },
  /**
   * Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"): links the server of the shared store into the
   * home folder of the remote user (its arguments: the commit and the quality), as that user, when the store has it.
   */
  vscodeServerLink: { program: 'sh', script: VSCODE_SERVER_LINK_SCRIPT },
  /**
   * Fix after the live check of 2026-10-10: answers whether the home folder of the remote user has the server of the
   * window already (its arguments: the commit and the quality), as that user; it only tests, so the open does not wait for
   * a download into the store that the link would not use.
   */
  vscodeServerPresent: { program: 'sh', script: VSCODE_SERVER_PRESENT_SCRIPT },
  /**
   * Plan step 11H3 (decision of 2026-10-09; live check 3): copies the cached `.vsix` files of the shared store into the
   * extension cache of the remote user's VS Code server (its arguments: the quality, the engine's platform, the files), as
   * that user, never replacing a file.
   */
  vscodeExtensionSeed: { program: 'sh', script: VSCODE_EXTENSION_SEED_SCRIPT },
} as const satisfies Record<string, ScriptEntry>;

/** The name of a script of the registry. */
export type ContainerScript = keyof typeof CONTAINER_SCRIPTS;

/**
 * Plan step 11I (PR B): the `exec` through which a script runs, as its caller has it: DockerEngine.exec of the worker's
 * engine, or EnvironmentDocker.exec of the pipeline (EngineDocker over that engine). Only what a script needs: its user,
 * its time limit, its cancel, and the name of the secret that is its standard input. Plan step 11I (U2, decision of
 * 2026-10-08): and the plain standard input of an entry that reads one (`plainInput`).
 */
export interface ScriptExec {
  exec(
    container: string,
    command: readonly string[],
    options: Pick<EngineExecOptions, 'user' | 'timeoutMs' | 'signal' | 'input'> & { secretInputName?: typeof SECRET_TOKEN },
  ): Promise<EngineExecResult>;
}

/**
 * The options of a run of a script: never a secret of the caller (the entry names its secret). Plan step 11I (U2,
 * decision of 2026-10-08): `input` only for an entry with `plainInput` (runScript refuses it for any other entry).
 */
export type ScriptOptions = Pick<EngineExecOptions, 'user' | 'timeoutMs' | 'signal'> & {
  /** The plain standard input of an entry that reads one (the JSON of the image settings or list); never a secret. */
  input?: string;
};

/** The command of the script `name` with the arguments `args` (positional parameters, never part of the script text). */
export function scriptCommand(name: ContainerScript, args: readonly string[]): string[] {
  const entry: ScriptEntry = CONTAINER_SCRIPTS[name];
  if ('command' in entry) return [...entry.command, ...args];
  return ['sh', '-c', entry.script, 'sh', ...args];
}

/**
 * Plan step 11B1: runs the script `name` in the container through the one primitive of the port. Its arguments are
 * positional parameters; a script that takes a secret gets it as the standard input of the process (never an argument).
 * Plan step 11I (PR B): the one way to run a script of the registry, for the flows of the worker and the pipeline alike
 * (ScriptExec); the options of the caller are its user, time limit and cancel only. Plan step 11I (U2, decision of
 * 2026-10-08): and the plain input of an entry that reads one; an input for any other entry rejects before anything runs.
 */
export async function runScript(
  target: ScriptExec,
  container: string,
  name: ContainerScript,
  args: readonly string[],
  options: ScriptOptions = {},
): Promise<EngineExecResult> {
  const entry: ScriptEntry = CONTAINER_SCRIPTS[name];
  const plainInput = 'plainInput' in entry && entry.plainInput === true;
  if (options.input !== undefined && !plainInput) throw new Error(`The script ${name} of the registry takes no input.`);
  return target.exec(container, scriptCommand(name, args), {
    ...(options.user !== undefined ? { user: options.user } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(plainInput && options.input !== undefined ? { input: options.input } : {}),
    ...('secretInputName' in entry && entry.secretInputName !== undefined ? { secretInputName: entry.secretInputName } : {}),
  });
}
