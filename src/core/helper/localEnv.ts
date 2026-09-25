// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `${localEnv:NAME}` variables of devcontainer.json (implementation notes 7). The Dev Container CLI runs in the workspace
// helper, and the extension does not pass the values of this computer to it (concept section 9 "Host access"): the CLI
// resolves the variables in the helper. A variable that the helper sets itself (HELPER_ENV_NAMES, for example HOME=/root)
// gets the value of the helper; any other one is empty or gets the default of the expression. The extension finds the
// variables in the configuration text, to name them in one warning.
import { stripJsonc } from '../jsonc';

// The CLI treats `${env:NAME}` as an alias of `${localEnv:NAME}`. A default value follows a second colon.
const VARIABLE = /\$\{(?:localEnv|env):([^:}]+)(?::[^}]*)?\}/g;

/**
 * Variables that are set in the workspace helper, where the CLI resolves `${localEnv:…}`: HOME (/root), PATH, and
 * HOSTNAME of Docker, and NODE_VERSION and YARN_VERSION of its base image (node). The pipeline passes no other variable.
 */
export const HELPER_ENV_NAMES: readonly string[] = ['HOME', 'PATH', 'HOSTNAME', 'NODE_VERSION', 'YARN_VERSION'];

/**
 * Names of the variables `${localEnv:NAME}` and `${localEnv:NAME:default}` in a configuration text (JSONC), in order,
 * without duplicates. Variables in comments are ignored.
 */
export function findLocalEnvNames(text: string): string[] {
  const names: string[] = [];
  for (const match of stripJsonc(text).matchAll(VARIABLE)) {
    const name = match[1].trim();
    if (name === '' || name.includes('=') || name.includes('\0') || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/** Those of `names` that the workspace helper sets itself (HELPER_ENV_NAMES), in their order. */
export function helperEnvNames(names: readonly string[]): string[] {
  return names.filter((name) => HELPER_ENV_NAMES.includes(name));
}
