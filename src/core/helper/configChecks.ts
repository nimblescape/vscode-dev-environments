// Checks of a devcontainer.json that the extension makes before it uses the configuration: Docker Compose
// (implementation notes 1), `${localWorkspaceFolder}` (concept RK-10, implementation notes 7), and the additional named
// volumes of the configuration (concept 7.14). Mounts of the computer are refused by the host access policy
// (hostAccess.ts), not reported here.
import { parseJsonc, stripJsonc } from '../jsonc';
import type { DevcontainerConfig } from '../types';

export interface ConfigurationProblems {
  /** `dockerComposeFile` is present → Messages.composeNotSupported. */
  compose: boolean;
  /** Short human-readable items: `${localWorkspaceFolder}`. */
  computerDependent: string[];
}

interface MountSpec {
  type?: string;
  source?: string;
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

/** Parses the `--mount` syntax `type=bind,source=/a,target=/b`. */
function parseMountString(spec: string): MountSpec {
  const result: MountSpec = {};
  for (const part of spec.split(',')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim().replace(/^"(.*)"$/, '$1');
    if (key === 'type') result.type = value.toLowerCase();
    else if (key === 'source' || key === 'src') result.source = value;
  }
  return result;
}

function mountFromEntry(entry: unknown): MountSpec | undefined {
  if (typeof entry === 'string') {
    const mount = parseMountString(entry);
    // Docker's default for --mount is a volume.
    return { ...mount, type: mount.type ?? 'volume' };
  }
  if (isRecord(entry)) {
    return {
      type: typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined,
      source: typeof entry.source === 'string' ? entry.source : undefined,
    };
  }
  return undefined;
}

/**
 * Source of a `-v`/`--volume` value `source:target[:options]`; undefined for an anonymous volume. A colon of a
 * Windows drive letter or inside a variable such as `${localEnv:HOME}` does not end the source.
 */
function volumeFlagSource(spec: string): string | undefined {
  let depth = 0;
  for (let i = /^[A-Za-z]:[\\/]/.test(spec) ? 2 : 0; i < spec.length; i++) {
    if (spec.startsWith('${', i)) {
      depth++;
      i++;
    } else if (spec[i] === '}' && depth > 0) {
      depth--;
    } else if (spec[i] === ':' && depth === 0) {
      return i > 0 ? spec.slice(0, i) : undefined;
    }
  }
  return undefined;
}

/** A `-v` source is a folder of the computer if it looks like a path; otherwise it is the name of a volume. */
function isPathSource(source: string): boolean {
  return /[\\/]/.test(source) || source.startsWith('.') || source.startsWith('~') || /^[A-Za-z]:/.test(source);
}

/** Mounts of docker run arguments: `-v`, `--volume`, and `--mount`, in the separate and in the `=` form. */
function mountsFromRunArgs(runArgs: readonly unknown[]): MountSpec[] {
  const mounts: MountSpec[] = [];
  for (let i = 0; i < runArgs.length; i++) {
    const arg = runArgs[i];
    if (typeof arg !== 'string') continue;
    const next = runArgs[i + 1];
    let volume: string | undefined;
    let mount: string | undefined;
    if (arg === '-v' || arg === '--volume') {
      if (typeof next === 'string') volume = next;
      i++;
    } else if (arg.startsWith('--volume=')) {
      volume = arg.slice('--volume='.length);
    } else if (arg.startsWith('-v') && !arg.startsWith('--')) {
      volume = arg.slice(2).replace(/^=/, '');
    } else if (arg === '--mount') {
      if (typeof next === 'string') mount = next;
      i++;
    } else if (arg.startsWith('--mount=')) {
      mount = arg.slice('--mount='.length);
    }
    if (volume !== undefined) {
      const source = volumeFlagSource(volume);
      if (source !== undefined) mounts.push({ type: isPathSource(source) ? 'bind' : 'volume', source });
    } else if (mount !== undefined) {
      const parsed = parseMountString(mount);
      mounts.push({ ...parsed, type: parsed.type ?? 'volume' });
    }
  }
  return mounts;
}

function allMounts(config: Record<string, unknown>): MountSpec[] {
  const mounts: MountSpec[] = [];
  if (Array.isArray(config.mounts)) {
    for (const entry of config.mounts) {
      const mount = mountFromEntry(entry);
      if (mount) mounts.push(mount);
    }
  }
  if (Array.isArray(config.runArgs)) mounts.push(...mountsFromRunArgs(config.runArgs));
  return mounts;
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

// Docker's rule for volume names (local driver).
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/;

/**
 * Named volumes of the configuration (concept 7.14): `mounts` with type=volume in the string and the object form, and
 * named volumes in `-v`/`--volume`/`--mount` of runArgs. Without duplicates, in order.
 * A source that is not a valid volume name is skipped: `devcontainer read-configuration` resolves `${devcontainerId}`
 * only when the container exists, so before the first `up` a source such as `${devcontainerId}-history` is still raw.
 */
export function additionalNamedVolumes(config: DevcontainerConfig): string[] {
  const names: string[] = [];
  for (const mount of allMounts(config)) {
    if (mount.type !== 'volume' || !mount.source || isPathSource(mount.source) || !VOLUME_NAME.test(mount.source)) continue;
    if (!names.includes(mount.source)) names.push(mount.source);
  }
  return names;
}
