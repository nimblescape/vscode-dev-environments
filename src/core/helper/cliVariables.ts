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
//   result of a replacement is not read again in the same pass. This module finds the same matches with a linear scan
//   (variableMatches): the pattern itself takes quadratic time on a text such as `${${${…` without `}` (hotfix review 1,
//   N5).
// - What read-configuration returns is substituted once. At `up`, the CLI substitutes the override configuration again
//   (its runArgs and appPort come from that output, so they are substituted twice), and each entry of the image
//   metadata once.
// - The text between the braces is split at every `:`: the first part is the name, the others are the arguments.
// - `env` and `localEnv`: the variable of the CLI process named by the first argument; when it is not set, the second
//   argument (the default, which cannot hold a `:`), otherwise ''. Without an argument, the CLI stops with an error.
// - `localWorkspaceFolder`: the folder of `--workspace-folder`; `localWorkspaceFolderBasename`: its posix basename.
// - `containerWorkspaceFolder`: the workspaceFolder of the configuration (for `up` with an override configuration: the
//   one of the override configuration, itself substituted first); `containerWorkspaceFolderBasename`: its basename.
// - Other names (also `containerEnv` for a new container) stay as they are written.
// - A second pass (tg) replaces `${devcontainerId}` (any expression with that name) by the ID of the container, a hash
//   of its id labels (52 characters of base 32). The checks use DEVCONTAINER_ID_PLACEHOLDER in its place, because the ID
//   is not known before `up` (hotfix review 2, P6).
// - `${containerEnv:…}` is resolved only for the lifecycle commands of an existing container (Hr), never in the
//   arguments of `docker run` (hotfix review 2, P4).
import * as path from 'path';
import { HELPER_ENV_NAMES } from './localEnv';
import { repositoryFolder } from '../names';

/**
 * The longest text (a string value or key) that the checks read, and the most text in one source (the configuration,
 * the merged configuration, or the whole image metadata), in characters (hotfix review 1, N5). Longer texts are not
 * supported: the Dev Container CLI would spend minutes on them in the helper (its pattern takes quadratic time). Real
 * labels hold a few kilobytes; a Feature's metadata rarely more than a few dozen.
 */
export const MAX_CLI_TEXT_LENGTH = 256 * 1024;
export const MAX_CLI_SOURCE_LENGTH = 1024 * 1024;

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
  return { localWorkspaceFolder: folder, containerWorkspaceFolder: folder, env: HELPER_KNOWN_ENV, mayBeSet: mayBeSetInHelper };
}

/**
 * The variables of the process of the Dev Container CLI in the workspace helper whose values are known (hotfix review 1,
 * N4): HOME. The helper runs as root (resources/helper/Dockerfile has no USER, and helperRunArgs passes no `--user`),
 * so Docker sets HOME=/root; the pipeline passes no variable to the CLI runs.
 */
export const HELPER_KNOWN_ENV: Readonly<Record<string, string>> = { HOME: '/root' };

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

/** A match of the pattern /\$\{(.*?)\}/g of the CLI: `text.slice(start, end)`, with the text between the braces. */
interface VariableMatch {
  start: number;
  end: number;
  inner: string;
}

/** A line terminator, which `.` of the pattern of the CLI does not match. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;

/**
 * The matches of the pattern /\$\{(.*?)\}/g of the CLI in `text`, in order, as String.prototype.replace finds them, in
 * linear time (hotfix review 1, N5): a match starts at a `${` and ends at the first `}` after it, when no line terminator
 * comes before that `}`; the search goes on after the match. A `${` without such a `}` is no match, and neither is any
 * other `${` before the next line terminator (its first `}` comes after that terminator too).
 */
export function variableMatches(text: string): VariableMatch[] {
  const matches: VariableMatch[] = [];
  // The first `}` and the first line terminator at or after a position; the positions only grow, so each is found once.
  let close: number | undefined;
  let lineEnd: number | undefined;
  const closeFrom = (position: number): number => {
    if (close === undefined || (close !== -1 && close < position)) close = text.indexOf('}', position);
    return close;
  };
  const lineEndFrom = (position: number): number => {
    if (lineEnd === undefined || (lineEnd !== -1 && lineEnd < position)) {
      LINE_TERMINATOR.lastIndex = position;
      const found = LINE_TERMINATOR.exec(text);
      lineEnd = found ? found.index : -1;
    }
    return lineEnd;
  };
  let position = 0;
  while (position < text.length) {
    const start = text.indexOf('${', position);
    if (start < 0) break;
    const end = closeFrom(start + 2);
    if (end < 0) break;
    const terminator = lineEndFrom(start + 2);
    if (terminator >= 0 && terminator < end) {
      position = terminator + 1;
      continue;
    }
    matches.push({ start, end: end + 1, inner: text.slice(start + 2, end) });
    position = end + 1;
  }
  return matches;
}

/** One pass of the CLI over a text: `resolve(match, name, args)` for each expression. */
function substituteText(text: string, resolve: (match: string, name: string, args: string[]) => string): string {
  const matches = variableMatches(text);
  if (matches.length === 0) return text;
  let result = '';
  let position = 0;
  for (const match of matches) {
    const parts = match.inner.split(':');
    result += text.slice(position, match.start) + resolve(text.slice(match.start, match.end), parts[0], parts.slice(1));
    position = match.end;
  }
  return result + text.slice(position);
}

/**
 * `value` with the variables of the Dev Container CLI resolved as `devcontainer up` resolves them (see the top of this
 * file): the first pass (local variables), then the second (`${devcontainerId}`, when `variables.devcontainerId` is
 * given). Expressions that the CLI would leave, and those of variables that `mayBeSet` names, stay as written; so does
 * `${env}` or `${localEnv}` without a variable name, where the CLI stops with an error.
 */
export function substituteCliVariables<T>(value: T, variables: CliVariables): T {
  return resolveCliVariables(value, variables).value;
}

/**
 * substituteCliVariables, with the leftovers of the first pass (hotfix review 2, P1): the expressions of the strings of
 * `value`, as they are written there, that the first pass keeps as written and that name a variable that the Dev
 * Container CLI resolves (CLI_VARIABLE_NAMES: a variable of the process that may be set, a workspace folder that is not
 * known, `${containerEnv:…}`, `${env}` without a name). Found on the raw strings while they are substituted, never by a
 * scan of the result: a result can hide such an expression (`${localEnv:A:$}{,src=${localEnv:TERM}` becomes
 * `${,src=${localEnv:TERM}`, whose first match names no variable), and it can show one that the CLI never resolves (the
 * CLI does not read a result again in the same pass). In order, without duplicates.
 */
export function resolveCliVariables<T>(value: T, variables: CliVariables): { value: T; leftovers: string[] } {
  const env = variables.env ?? {};
  const mayBeSet = variables.mayBeSet ?? (() => false);
  const leftovers = new Set<string>();
  const left = (match: string): string => {
    leftovers.add(match);
    return match;
  };
  // The leftovers of the workspaceFolder of the configuration, which the CLI substitutes first (see below): a use of
  // `${containerWorkspaceFolder…}` leaves them too.
  let folderLeftovers: string[] = [];
  const folder = (match: string, value: string | undefined): string => {
    if (value === undefined) return left(match);
    for (const expression of folderLeftovers) leftovers.add(expression);
    return value;
  };
  const local = (match: string, name: string, args: string[], containerFolder: string | undefined): string => {
    switch (name) {
      case 'env':
      case 'localEnv': {
        if (args.length === 0) return left(match);
        const variable = args[0];
        const known = Object.prototype.hasOwnProperty.call(env, variable) ? env[variable] : undefined;
        if (typeof known === 'string') return known;
        if (mayBeSet(variable)) return left(match);
        return args.length > 1 ? args[1] : '';
      }
      case 'localWorkspaceFolder':
        return variables.localWorkspaceFolder ?? left(match);
      case 'localWorkspaceFolderBasename':
        return variables.localWorkspaceFolder !== undefined ? path.posix.basename(variables.localWorkspaceFolder) : left(match);
      case 'containerWorkspaceFolder':
        return folder(match, containerFolder);
      case 'containerWorkspaceFolderBasename':
        return folder(match, containerFolder !== undefined ? path.posix.basename(containerFolder) : undefined);
      default:
        return CLI_VARIABLE_NAMES.includes(name) ? left(match) : match;
    }
  };
  // The CLI substitutes the workspaceFolder of the configuration itself first, with its unsubstituted value for
  // `${containerWorkspaceFolder}` (Fo); an empty one is used as it is.
  const raw = variables.containerWorkspaceFolder;
  const containerFolder = raw ? substituteText(raw, (match, name, args) => local(match, name, args, raw)) : raw;
  folderLeftovers = [...leftovers];
  leftovers.clear();
  const first = mapStrings(value, (text) => substituteText(text, (match, name, args) => local(match, name, args, containerFolder)));
  const id = variables.devcontainerId;
  return { value: (id ? devcontainerIdPass(first, id) : first) as T, leftovers: [...leftovers] };
}

/** The second pass of the CLI (tg): every expression named `devcontainerId`, with or without arguments, becomes `id`. */
function devcontainerIdPass(value: unknown, id: string): unknown {
  return mapStrings(value, (text) => substituteText(text, (match, name) => (name === DEVCONTAINER_ID_VARIABLE ? id : match)));
}

/**
 * The ID that the checks put in place of `${devcontainerId}` (hotfix review 2, P6), shaped like the ID that the CLI
 * computes (52 characters of base 32, `0-9a-v`), without any of `, = " $ { } :`, and named like no volume of Dev
 * Environments or of the workspace helper. The ID of a container is not known before `up`, and the CLI replaces the
 * whole expression, also one with arguments (`${devcontainerId:,type=bind}`), so its text must not be read as fields
 * of a mount. A name with it is never the name of a real volume (mountedVolumeNames skips it), and a configuration that
 * writes it is not supported (hostAccessFindings).
 */
export const DEVCONTAINER_ID_PLACEHOLDER = `devcontaineridplaceholder${'v'.repeat(27)}`;

/**
 * `value` after the second pass of the CLI with DEVCONTAINER_ID_PLACEHOLDER for the ID: what Docker gets, up to the
 * ID, for a value that the first pass has substituted (hotfix review 2, P6).
 */
export function withDevcontainerIdPlaceholder<T>(value: T): T {
  return devcontainerIdPass(value, DEVCONTAINER_ID_PLACEHOLDER) as T;
}

/**
 * The names of the variables that the CLI resolves in its second pass over the runArgs and appPort of the override
 * configuration at `up` (Fo): not `containerEnv`, which it resolves only for the lifecycle commands of an existing
 * container, never in the arguments of `docker run` (hotfix review 2, P4).
 */
export const SECOND_PASS_VARIABLE_NAMES: readonly string[] = CLI_VARIABLE_NAMES.filter((name) => name !== 'containerEnv');

/**
 * The expressions `${…}` of a text that name a variable that the Dev Container CLI resolves (`names`, by default
 * CLI_VARIABLE_NAMES): for a text that the CLI substitutes (again) as it is, such as the runArgs of the override
 * configuration (secondPassProblems, with SECOND_PASS_VARIABLE_NAMES), or a text that the CLI has substituted already
 * and that a mount of the configuration uses: a variable of the process that may be set (its value is not known), a
 * workspace folder that is not known, `${containerEnv:…}`, or an expression without a variable name. Not
 * `${devcontainerId}`, which the CLI resolves to an opaque ID, and not unknown names, which reach Docker as they are
 * written (a `$` in the name of a volume is refused by Docker). In order, without duplicates. The leftovers of the
 * image metadata are found on its raw strings instead (resolveCliVariables).
 */
export function unresolvedCliVariables(text: string, names: readonly string[] = CLI_VARIABLE_NAMES): string[] {
  const found = new Set<string>();
  for (const match of variableMatches(text)) {
    const name = nameOf(match.inner);
    if (name === DEVCONTAINER_ID_VARIABLE || !names.includes(name)) continue;
    found.add(text.slice(match.start, match.end));
  }
  return [...found];
}

/** Whether a string of `value` (values and keys, recursively) holds `text`. */
export function containsText(value: unknown, text: string): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') {
      if (next.includes(text)) return true;
    } else if (next !== null && typeof next === 'object' && !seen.has(next)) {
      seen.add(next);
      if (Array.isArray(next)) for (const entry of next) pending.push(entry);
      else {
        for (const [key, entry] of Object.entries(next)) {
          if (key.includes(text)) return true;
          pending.push(entry);
        }
      }
    }
  }
  return false;
}

/**
 * The length of the longest text in `value` (string values and keys of objects, entries of arrays) and the sum of all,
 * in characters, without recursion (hotfix review 1, N5: MAX_CLI_TEXT_LENGTH, MAX_CLI_SOURCE_LENGTH).
 */
export function textLengths(value: unknown): { longest: number; total: number } {
  let longest = 0;
  let total = 0;
  const count = (text: string): void => {
    longest = Math.max(longest, text.length);
    total += text.length;
  };
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') count(next);
    else if (next !== null && typeof next === 'object' && !seen.has(next)) {
      seen.add(next);
      if (Array.isArray(next)) for (const entry of next) pending.push(entry);
      else {
        for (const [key, entry] of Object.entries(next)) {
          count(key);
          pending.push(entry);
        }
      }
    }
  }
  return { longest, total };
}
