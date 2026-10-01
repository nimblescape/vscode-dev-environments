// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the checks of the inputs of the helper steps and the commands of the runs of the Dev Container CLI,
// shared by WorkspaceHelper and the batch helper (batchSteps.ts), so that both build every command from the same builders
// (moved here from workspaceHelper.ts unchanged, except the names refused by isPassableEnvName). Plan step 7 (user
// decision of 2026-10-01): the per-step runs of WorkspaceHelper are removed; its steps run only in the batch helper.
// Pure functions. No `vscode`.
import { splitRepository } from '../names';
import { OVERRIDE_CONFIG_PATH, OVERRIDE_FOLDER, upCommand, writeAndRunCommand } from './scripts';

/** Files of the extension for a run of the Dev Container CLI (WRITE_AND_RUN_SCRIPT): absolute path below OVERRIDE_FOLDER → text. */
export type HelperFiles = Readonly<Record<string, string>>;

// Variables that would break the tools in the helper (or point them to the computer) if a caller passed them with the
// `env` option of a step. The pipeline passes no variable of the computer: `${localEnv:…}` resolves in the helper, to the
// value of the helper for a variable that it sets itself (HELPER_ENV_NAMES, for example HOME=/root), otherwise to an empty
// value or the default of the expression (concept section 9 "Host access").
// Plan step 6, PR B: also the variables of the Dev Containers extension and of VS Code (REMOTE_CONTAINERS*, VSCODE_*),
// SSH_AUTH_SOCK and BROWSER, which would hand a channel of the computer to the tools; they are never passed or set.
const RESERVED_ENV_NAMES = new Set(['PATH', 'HOSTNAME', 'PWD', 'OLDPWD', 'SHLVL', 'IFS', 'ENV', 'TMPDIR', 'TMP', 'TEMP', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'BROWSER']);
const RESERVED_ENV_PREFIXES = ['DOCKER_', 'BUILDX_', 'BUILDKIT_', 'LD_', 'REMOTE_CONTAINERS', 'VSCODE_'];

/** Whether a local variable may be passed to the helper (`-e NAME=value`, or on the process of a batch step). DOCKER_HOST never is. */
export function isPassableEnvName(name: string): boolean {
  if (name === '' || name.includes('=') || name.includes('\0')) return false;
  const upper = name.toUpperCase();
  return !RESERVED_ENV_NAMES.has(upper) && !RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Validates `owner/name` (GitHub names: letters, digits, `.`, `-`, `_`), so it can be part of a URL and a path. */
export function checkRepository(repository: string): { owner: string; name: string } {
  const parts = splitRepository(repository);
  for (const part of [parts.owner, parts.name]) {
    if (!/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..' || part.startsWith('-')) {
      throw new Error(`Invalid repository name: ${repository}`);
    }
  }
  return parts;
}

/**
 * A configuration path relative to the repository folder, without `..`. Review round 6 (note of S): a backslash is allowed, as the
 * discovery and isConfigPathLabelValue allow it; in the workspace helper (Linux) it is a character of a name, no
 * separator, and the path goes to the scripts as an argument, never through a shell.
 */
export function checkConfigPath(configPath: string): string {
  const segments = configPath.split('/');
  if (
    configPath === '' ||
    configPath.startsWith('/') ||
    configPath.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid configuration path: ${configPath}`);
  }
  return configPath;
}

/** Paths of `files` below OVERRIDE_FOLDER, absolute and without `.`/`..` (WRITE_AND_RUN_SCRIPT checks them again). */
function checkHelperFiles(files: HelperFiles): void {
  for (const file of Object.keys(files)) {
    const segments = file.split('/').slice(1);
    if (!file.startsWith(`${OVERRIDE_FOLDER}/`) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`Invalid helper file: ${file}`);
    }
  }
}

/** Standard input of WRITE_AND_RUN_SCRIPT: the files, and the override configuration at OVERRIDE_CONFIG_PATH. */
export function writeAndRunInput(files: HelperFiles | undefined, override: Record<string, unknown> | undefined): string {
  const all: Record<string, string> = { ...(files ?? {}) };
  if (override !== undefined) all[OVERRIDE_CONFIG_PATH] = JSON.stringify(override, null, 2);
  checkHelperFiles(all);
  return JSON.stringify({ files: all });
}

/**
 * The helper command of `up` and `run-user-commands`: UP_SCRIPT with the override configuration on stdin, or, with
 * `files` (Docker Compose: our model), WRITE_AND_RUN_SCRIPT.
 */
export function overrideCommand(args: readonly string[], files: HelperFiles | undefined): string[] {
  return files !== undefined ? writeAndRunCommand({}, args) : upCommand(OVERRIDE_CONFIG_PATH, args);
}

/** The standard input of overrideCommand. */
export function overrideInput(files: HelperFiles | undefined, override: Record<string, unknown>): string {
  return files !== undefined ? writeAndRunInput(files, override) : JSON.stringify(override, null, 2);
}
