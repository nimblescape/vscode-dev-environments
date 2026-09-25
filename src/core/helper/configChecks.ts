// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Checks of a devcontainer.json that the extension makes before it uses the configuration: Docker Compose
// (implementation notes 1) and `${localWorkspaceFolder}` (concept RK-10, implementation notes 7). Mounts of the computer
// are refused by the host access policy, and its parser also gives the named volumes of an environment (hostAccess.ts,
// mountedVolumeNames).
import { parseJsonc, stripJsonc } from '../jsonc';

export interface ConfigurationProblems {
  /** `dockerComposeFile` is present → Messages.composeNotSupported. */
  compose: boolean;
  /** Short human-readable items: `${localWorkspaceFolder}`. */
  computerDependent: string[];
}

const LOCAL_WORKSPACE_FOLDER = /\$\{localWorkspaceFolder\}/;

// Properties where `${localWorkspaceFolder}` is not reported: the override configuration of `up` replaces workspaceMount
// and workspaceFolder, `name` is only a label, the host access policy refuses initializeCommand and bind mounts
// (`mounts`, and `-v`/`--mount` of runArgs), and the other runArgs are read in the workspace helper, where the variable
// is the folder of the repository in the volume (for example `--env-file`).
const HARMLESS_PROPERTIES = ['workspaceFolder', 'workspaceMount', 'name', 'initializeCommand', 'mounts', 'runArgs'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * configText: raw devcontainer.json text (JSONC). Finds `${localWorkspaceFolder}` outside of the properties where it
 * does no harm or where the host access policy decides. Text in comments is ignored.
 *
 * `${localWorkspaceFolderBasename}` is not reported: in the helper the CLI resolves it to the repository name, which is
 * the name of a local clone too.
 */
export function checkConfiguration(configText: string): ConfigurationProblems {
  let config: Record<string, unknown> | undefined;
  try {
    const parsed = parseJsonc<unknown>(configText);
    if (isRecord(parsed)) config = parsed;
  } catch {
    config = undefined;
  }

  if (!config) {
    // Invalid JSON: the Dev Container CLI reports the syntax error later. Check the text as well as possible.
    const text = stripJsonc(configText);
    return {
      compose: /"dockerComposeFile"\s*:/.test(text),
      computerDependent: LOCAL_WORKSPACE_FOLDER.test(text) ? ['${localWorkspaceFolder}'] : [],
    };
  }

  const compose = config.dockerComposeFile !== undefined && config.dockerComposeFile !== null;
  const items: string[] = [];
  const relevant = Object.fromEntries(Object.entries(config).filter(([key]) => !HARMLESS_PROPERTIES.includes(key)));
  if (LOCAL_WORKSPACE_FOLDER.test(JSON.stringify(relevant))) items.push('${localWorkspaceFolder}');
  return { compose, computerDependent: items };
}
