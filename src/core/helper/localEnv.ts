// `${localEnv:NAME}` variables of devcontainer.json (implementation notes 7). The Dev Container CLI runs in the
// workspace helper, so without help it would resolve these variables with the environment of the helper container.
// The extension finds them in the configuration text and passes the values of this computer to the helper.
import { stripJsonc } from '../jsonc';

// The CLI treats `${env:NAME}` as an alias of `${localEnv:NAME}`. A default value follows a second colon.
const VARIABLE = /\$\{(?:localEnv|env):([^:}]+)(?::[^}]*)?\}/g;

/**
 * Names of the variables `${localEnv:NAME}` and `${localEnv:NAME:default}` in a configuration text (JSONC), in order,
 * without duplicates. Variables in comments are ignored, so that no value leaves the computer without need.
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

/**
 * Local values of the variables. Only variables with a value are included: for a missing variable, the CLI uses the
 * default of the expression. On Windows, variable names are not case-sensitive.
 */
export function localEnvValues(
  names: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    let value = env[name];
    if (value === undefined && platform === 'win32') {
      const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
      value = key === undefined ? undefined : env[key];
    }
    if (value !== undefined) values[name] = value;
  }
  return values;
}
