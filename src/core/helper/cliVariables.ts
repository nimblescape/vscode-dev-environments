// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The variables `${…}` of devcontainer.json and of the label devcontainer.metadata, resolved as Dev Container CLI 0.89.0
// resolves them at `up` (concept section 9 "Host access"): the CLI substitutes every entry of the image metadata, the
// configuration, and the override configuration before it passes the mounts to `docker run`, so the host access policy
// checks the values that Docker gets, not the text that the configuration writes. Pure functions, no I/O.
//
// How the CLI substitutes (devContainersSpecCLI.js of 0.89.0, functions Fo, za, lN, I_, C_, hN, tg, E_):
// - The pattern /\$\{(.*?)\}/g, applied to the string values (not the keys) of objects and arrays, recursively. The
//   result of a replacement is not read again in the same pass.
// - The text between the braces is split at every `:`: the first part is the name, the others are the arguments.
// - `env` and `localEnv`: the variable of the CLI process named by the first argument; when it is not set, the second
//   argument (the default, which cannot hold a `:`), otherwise ''. Without an argument, the CLI stops with an error.
// - `localWorkspaceFolder`: the folder of `--workspace-folder`; `localWorkspaceFolderBasename`: its posix basename.
// - `containerWorkspaceFolder`: the workspaceFolder of the configuration (for `up` with an override configuration: the
//   one of the override configuration, itself substituted first); `containerWorkspaceFolderBasename`: its basename.
// - Other names (also `containerEnv` for a new container) stay as they are written.
// - A second pass (tg) replaces `${devcontainerId}` (any expression with that name) by the ID of the container, a hash
//   of its id labels (52 characters of base 32).
import * as path from 'path';
import { HELPER_ENV_NAMES } from './localEnv';
import { repositoryFolder } from '../names';

/** The pattern of the Dev Container CLI. */
const VARIABLE = /\$\{(.*?)\}/g;

/** Names that the Dev Container CLI resolves (or would resolve for an existing container: `containerEnv`). */
const CLI_VARIABLE_NAMES: readonly string[] = [
  'env',
  'localEnv',
  'localWorkspaceFolder',
  'localWorkspaceFolderBasename',
  'containerWorkspaceFolder',
  'containerWorkspaceFolderBasename',
  'containerEnv',
];

/** The name of the ID of the container, resolved only at `up` (second pass of the CLI). */
export const DEVCONTAINER_ID_VARIABLE = 'devcontainerId';

/**
 * Variables that can be set in the process of the Dev Container CLI in the workspace helper, whose values the extension
 * does not know exactly: the variables that the helper sets itself (HELPER_ENV_NAMES: HOME, PATH, and HOSTNAME of
 * Docker, NODE_VERSION and YARN_VERSION of the node base image of resources/helper/Dockerfile), those of the shell of
 * UP_SCRIPT and BUILD_SCRIPT (PWD, OLDPWD, SHLVL, `_`), TERM, and the proxy variables that the Docker CLI adds to
 * `docker run` from its configuration (`proxies` of ~/.docker/config.json). The pipeline passes no other variable to
 * the CLI runs. Case-sensitive, as on Linux.
 */
export const HELPER_PROCESS_ENV_NAMES: readonly string[] = [
  ...HELPER_ENV_NAMES,
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'TERM',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'FTP_PROXY',
  'ftp_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
];

/** What the substitution knows about the process of the Dev Container CLI. */
export interface CliVariables {
  /** `--workspace-folder`. `undefined`: `${localWorkspaceFolder…}` stays as written (as in the CLI). */
  localWorkspaceFolder?: string;
  /** workspaceFolder of the configuration of `up`. `undefined`: `${containerWorkspaceFolder…}` stays as written. */
  containerWorkspaceFolder?: string;
  /** Variables of the CLI process whose values are known. */
  env?: Readonly<Record<string, string>>;
  /**
   * Whether a variable that `env` does not hold may still be set in the CLI process (with a value that is not known).
   * Such a `${env:…}` or `${localEnv:…}` stays as written, so that the caller sees that it cannot be checked
   * (unresolvedCliVariables). Default: none (every other variable is not set, as in the CLI with `env`).
   */
  mayBeSet?: (name: string) => boolean;
  /** The ID of the container for `${devcontainerId}`. `undefined`: it stays as written (not known before `up`). */
  devcontainerId?: string;
}

/**
 * The variables of the Dev Container CLI in the workspace helper for the repository `repository` (owner/name): the
 * pipeline runs `up` with `--workspace-folder /workspaces/<name>` and an override configuration whose workspaceFolder
 * is the same folder (buildOverrideConfig). No value of a variable of the process is known: the variables of
 * HELPER_PROCESS_ENV_NAMES may be set, every other one is not.
 */
export function helperCliVariables(repository: string): CliVariables {
  const folder = repositoryFolder(repository);
  return { localWorkspaceFolder: folder, containerWorkspaceFolder: folder, mayBeSet: mayBeSetInHelper };
}

/** Whether the process of the Dev Container CLI in the workspace helper may have the variable `name` (HELPER_PROCESS_ENV_NAMES). */
export function mayBeSetInHelper(name: string): boolean {
  return HELPER_PROCESS_ENV_NAMES.includes(name);
}

/** The name of an expression `${name:arg…}`: the text before the first `:`. */
function nameOf(inner: string): string {
  const index = inner.indexOf(':');
  return index < 0 ? inner : inner.slice(0, index);
}

/** Applies `replace` to every string in `value` (values of objects and entries of arrays, not keys), as the CLI does. */
function mapStrings(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, replace));
  if (value !== null && typeof value === 'object') {
    // fromEntries creates own properties, also for a key `__proto__`, like the CLI's Object.create(null).
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, replace)]));
  }
  return value;
}

/** One pass of the CLI over a text: `resolve(match, name, args)` for each expression. */
function substituteText(text: string, resolve: (match: string, name: string, args: string[]) => string): string {
  return text.replace(VARIABLE, (match: string, inner: string) => {
    const parts = inner.split(':');
    return resolve(match, parts[0], parts.slice(1));
  });
}

/**
 * `value` with the variables of the Dev Container CLI resolved as `devcontainer up` resolves them (see the top of this
 * file): the first pass (local variables), then the second (`${devcontainerId}`, when `variables.devcontainerId` is
 * given). Expressions that the CLI would leave, and those of variables that `mayBeSet` names, stay as written; so does
 * `${env}` or `${localEnv}` without a variable name, where the CLI stops with an error.
 */
export function substituteCliVariables<T>(value: T, variables: CliVariables): T {
  const env = variables.env ?? {};
  const mayBeSet = variables.mayBeSet ?? (() => false);
  const local = (match: string, name: string, args: string[], containerFolder: string | undefined): string => {
    switch (name) {
      case 'env':
      case 'localEnv': {
        if (args.length === 0) return match;
        const variable = args[0];
        const known = Object.prototype.hasOwnProperty.call(env, variable) ? env[variable] : undefined;
        if (typeof known === 'string') return known;
        if (mayBeSet(variable)) return match;
        return args.length > 1 ? args[1] : '';
      }
      case 'localWorkspaceFolder':
        return variables.localWorkspaceFolder ?? match;
      case 'localWorkspaceFolderBasename':
        return variables.localWorkspaceFolder !== undefined ? path.posix.basename(variables.localWorkspaceFolder) : match;
      case 'containerWorkspaceFolder':
        return containerFolder ?? match;
      case 'containerWorkspaceFolderBasename':
        return containerFolder !== undefined ? path.posix.basename(containerFolder) : match;
      default:
        return match;
    }
  };
  // The CLI substitutes the workspaceFolder of the configuration itself first, with its unsubstituted value for
  // `${containerWorkspaceFolder}` (Fo); an empty one is used as it is.
  const raw = variables.containerWorkspaceFolder;
  const containerFolder = raw ? substituteText(raw, (match, name, args) => local(match, name, args, raw)) : raw;
  const first = mapStrings(value, (text) => substituteText(text, (match, name, args) => local(match, name, args, containerFolder)));
  const id = variables.devcontainerId;
  if (!id) return first as T;
  return mapStrings(first, (text) => substituteText(text, (match, name) => (name === DEVCONTAINER_ID_VARIABLE ? id : match))) as T;
}

/**
 * The expressions `${…}` that are left in a substituted text (substituteCliVariables) and name a variable that the
 * Dev Container CLI resolves: a variable of the process that may be set (its value is not known), a workspace folder
 * that is not known, `${containerEnv:…}`, or an expression without a variable name. Not `${devcontainerId}`, which the
 * CLI resolves to an opaque ID that cannot be the name of a volume of Dev Environments, and not unknown names, which
 * reach Docker as they are written (a `$` in the name of a volume is refused by Docker). In order, without duplicates.
 */
export function unresolvedCliVariables(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(VARIABLE)) {
    const name = nameOf(match[1]);
    if (name === DEVCONTAINER_ID_VARIABLE || !CLI_VARIABLE_NAMES.includes(name)) continue;
    if (!found.includes(match[0])) found.push(match[0]);
  }
  return found;
}
