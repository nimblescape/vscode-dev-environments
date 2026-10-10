// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What the container policy changes in the final configuration instead of refusing it: the flags of `runArgs` that the
// override configuration does not pass to Docker (removedRunArgs, overrideRunArgs), 127.0.0.1 for published ports
// without an address (loopbackRunArgs, loopbackAppPorts; not while the checks are off), whether the runArgs decide the
// host name, and for Docker Compose the decision for each mount and published port of a service (decideServiceMount,
// decideServicePort), which the check (./compose.ts) and the model that runs (../helper/compose.ts) share. Pure, no I/O.
import * as path from 'path';
import { WORKSPACES_ROOT } from '../names';
import { MIN_SUBPATH_ENGINE, WORKSPACE_VOLUME_KEY, supportsVolumeSubpath } from '../helper/composeModel';
import {
  isLoopbackAddress,
  networkNames,
  parseFlags,
  splitPortAddress,
  withLoopbackAddress,
  type ParsedFlag,
} from './dockerFlags';
import { RUN_FLAGS } from './flags';
import {
  configFolderMountItem,
  configFolderTarget,
  isHelperPath,
  isSharedPropagation,
  sharedPropagationItem,
  tokenPropagationTarget,
} from './rules';
import { isRecord } from '../valueChecks';

// ---------------------------------------------------------------------------------------------------------------------
// runArgs and appPort of a single container

/**
 * Whether `runArgs` decide the host name of the container themselves, read as Docker reads the arguments (parseFlags):
 * with `--hostname`/`-h` (also in a group of short flags such as `-Ph`); with the network of another container (`--network container:<name>`, also as `--net` and in
 * the long form `name=container:<name>`, networkNames) or `--uts host`, where Docker refuses a host name; or with
 * `--network host`, where the container keeps the host name of the computer. A network value that Docker would read
 * otherwise counts too (the policy refuses it). The override configuration then adds no `--hostname`.
 */
export function runArgsDecideHostname(runArgs: readonly string[]): boolean {
  return parseFlags(runArgs, RUN_FLAGS).some((flag) => {
    if (flag.name === '--hostname' || flag.name === '-h') return true;
    // A group of short flags that parseFlags does not split (it holds a flag with a value), for example `-Ph mine`:
    // Docker may read an `-h` in it (the policy refuses such a group while the checks are on).
    if (flag.rule === undefined && /^-[A-Za-z]*h/.test(flag.raw)) return true;
    if (flag.value === undefined) return false;
    if (flag.name === '--network' || flag.name === '--net') {
      const networks = networkNames(flag.value);
      return !networks || networks.some((network) => /^(host$|container:)/i.test(network.trim()));
    }
    return flag.name === '--uts' && flag.value.trim().toLowerCase() === 'host';
  });
}

/** A flag that overrideRunArgs removes from `runArgs`, for the log. */
export interface RemovedRunArg {
  /** The entry as the configuration writes it, with the next entry when that is its value (for example `--name x`). */
  arg: string;
  /** Why it is removed. */
  reason: string;
}

/**
 * The entries of `runArgs` that are removed (rule `remove`), by index, with their flags, read as the policy reads them
 * (parseFlags): a flag that is the value of another flag (for example `--label --rm`) stays, so the other arguments
 * keep their meaning for Docker. A group of short flags (`-it`) is removed only when each of its flags is. `names`:
 * only these flags.
 */
function removals(runArgs: readonly string[], names?: readonly string[]): Map<number, ParsedFlag[]> {
  const entries = new Map<number, ParsedFlag[]>();
  for (const flag of parseFlags(runArgs, RUN_FLAGS)) {
    entries.set(flag.index, [...(entries.get(flag.index) ?? []), flag]);
  }
  const removes = (flag: ParsedFlag): boolean =>
    flag.rule?.kind === 'remove' && (names === undefined || (flag.name !== undefined && names.includes(flag.name)));
  const removed = new Map<number, ParsedFlag[]>();
  for (const [index, flags] of entries) if (flags.every(removes)) removed.set(index, flags);
  return removed;
}

/** `runArgs` without the entries of `removed`, and without the next entry where it is the value of a removed flag. */
function withoutRemovals(runArgs: readonly string[], removed: ReadonlyMap<number, readonly ParsedFlag[]>): string[] {
  const dropped = new Set<number>();
  for (const [index, flags] of removed) {
    dropped.add(index);
    if (flags.some((flag) => flag.form === 'next')) dropped.add(index + 1);
  }
  return runArgs.filter((_arg, index) => !dropped.has(index));
}

/**
 * `runArgs` without `--name <value>` and `--name=<value>` (the override configuration adds the name of the environment).
 * The flags are read as the policy reads them (parseFlags), so a `--name` that is the value of another flag (for example
 * `--label --name`) stays, and the other arguments keep their meaning for Docker.
 */
export function withoutNameArgs(runArgs: readonly string[]): string[] {
  return withoutRemovals(runArgs, removals(runArgs, ['--name']));
}

/**
 * The flags of `runArgs` that the override configuration does not pass to Docker (overrideRunArgs), in order, for the
 * log: `--name` (the extension adds the name of the environment), `--rm` (the extension stops, starts, and recreates
 * the container itself), `--restart` (review round 8, S8-6: Docker would start the container again when Docker
 * starts, outside the Session Monitor), and `-i`, `-t`, and `-d`, also in a group such as `-it`: with the arguments of
 * the Dev Container CLI, they do nothing or make the start fail.
 */
export function removedRunArgs(runArgs: readonly string[]): RemovedRunArg[] {
  return [...removals(runArgs)].map(([index, flags]) => {
    const withValue = flags.some((flag) => flag.form === 'next');
    const reasons = flags.map((flag) => (flag.rule?.kind === 'remove' ? flag.rule.reason : ''));
    return {
      arg: withValue ? `${runArgs[index]} ${runArgs[index + 1]}` : runArgs[index],
      reason: [...new Set(reasons)].join('; '),
    };
  });
}

/**
 * The repository part of `runArgs` in the override configuration of `devcontainer up`, the list that Docker gets: the
 * entries that are text (the policy refuses a list with other entries), without the removed flags (removedRunArgs, read
 * with the parser of the policy), and with 127.0.0.1 for published ports without an address (loopbackRunArgs), unless
 * the host access checks are off (`checksOn` false: the ports keep the address that the configuration gives them).
 * hostAccessProblems checks this list too, and the pipeline checks the complete list of the override configuration
 * again before `up`.
 */
export function overrideRunArgs(runArgs: unknown, checksOn = true): string[] {
  const texts = Array.isArray(runArgs) ? runArgs.filter((arg): arg is string => typeof arg === 'string') : [];
  const kept = withoutRemovals(texts, removals(texts));
  return checksOn ? loopbackRunArgs(kept) : kept;
}

/**
 * `runArgs` with 127.0.0.1 for each `-p`/`--publish` that names no address (concept section 9 "Host access": the
 * published ports of a container reach the computer only on localhost). Other arguments stay as they are; `--network host`
 * is left unchanged, and Docker ignores `-p` there.
 */
export function loopbackRunArgs(runArgs: readonly string[]): string[] {
  const result = [...runArgs];
  for (const flag of parseFlags(runArgs, RUN_FLAGS)) {
    if ((flag.name !== '-p' && flag.name !== '--publish') || flag.value === undefined) continue;
    const value = withLoopbackAddress(flag.value);
    if (flag.form === 'next') result[flag.index + 1] = value;
    else result[flag.index] = flag.name === '--publish' ? `--publish=${value}` : `-p${value}`;
  }
  return result;
}

/**
 * `appPort` for the override configuration (concept section 9 "Host access"): each port on 127.0.0.1. A number `n` is
 * `127.0.0.1:n:n` (as the Dev Container CLI publishes it), a string gets 127.0.0.1 when it names no address.
 * `undefined` without ports.
 */
export function loopbackAppPorts(appPort: unknown): string[] | undefined {
  if (appPort === undefined || appPort === null) return undefined;
  const ports = Array.isArray(appPort) ? appPort : [appPort];
  const result: string[] = [];
  for (const port of ports) {
    if (typeof port === 'number') result.push(`127.0.0.1:${port}:${port}`);
    else if (typeof port === 'string' && port.trim() !== '') result.push(withLoopbackAddress(port));
  }
  return result.length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Mounts and ports of a service (shared by the check and the rewrite)

/**
 * What happens to a mount or a published port of a service. A refusal of the kind `hostAccess` is access to the computer
 * (HostAccessClass `computer`, lifted while the host access checks are off), unless `guarded` says that it stays refused
 * whatever the switch says (HostAccessClass `protected`: the workspace volume with the GitHub token, and a path whose
 * target is not clear).
 */
export type ComposeEntryDecision =
  | { action: 'keep' }
  | { action: 'drop'; reason: string }
  /**
   * `createFolder` (review round 8, P8-2): the source is a folder of the repository that does not exist yet; the pipeline
   * creates it in the workspace volume before `up` (composeUpModel's `createFolders`).
   */
  | { action: 'replace'; value: unknown; reason: string; createFolder?: string }
  | { action: 'refuse'; kind: 'hostAccess' | 'unsupported'; item: string; guarded?: true };

/** What decides the mounts of a service. */
export interface ComposeMountContext {
  /** The dev service gets the workspace volume at WORKSPACES_ROOT; the other services may not mount it. */
  isDev: boolean;
  /** The folder of the repository in the helper, for example `/workspaces/api`. */
  repositoryFolder: string;
  /** The top-level volumes of the model: key → Docker name. */
  volumeNames: ReadonlyMap<string, string>;
  /** The workspace volume of the environment. */
  ownVolume: string;
  /** The Docker Engine API version (supportsVolumeSubpath); `undefined` when it is not known. */
  engineApiVersion?: string;
  /** ComposeModelOutput.realPaths; without it, links are not checked. */
  realPaths?: Readonly<Record<string, string | null>>;
  /** ComposeModelOutput.mountAncestors (review round 8, P8-2). */
  mountAncestors?: Readonly<Record<string, string | null>>;
}

function isInside(file: string, folder: string): boolean {
  return file === folder || file.startsWith(`${folder}/`);
}

function normalizedTarget(target: unknown): string | undefined {
  if (typeof target !== 'string' || target === '') return undefined;
  const normal = path.posix.normalize(target);
  return normal.length > 1 ? normal.replace(/\/+$/, '') : normal;
}

/**
 * A mount of the `volumes` of a service (long syntax of `docker compose config`):
 * - `tmpfs` and anonymous volumes: kept; a named volume: kept (its name is checked with the top-level volumes), except
 *   the workspace volume in a service other than the dev service (it holds the GitHub token);
 * - a bind mount of the dev service at WORKSPACES_ROOT whose source is the repository folder or its parent (the
 *   templates' `../..:/workspaces`): dropped, the workspace volume takes its place;
 * - a bind mount of the dev service whose source is the parent of the repository folder, at another target: the
 *   workspace volume at that target;
 * - a bind mount whose source is in the repository folder (lexically, and, with `realPaths`, also after links): the
 *   workspace volume with `volume.subpath` (Docker Engine 26, API 1.45; refused with an older or unknown engine) and
 *   `nocopy` (so the content of the image never lands in the repository), read-only as before;
 * - every other bind mount, and the types npipe, cluster, and image: refused;
 * - in the dev service, any other mount at WORKSPACES_ROOT: refused (the workspace volume is mounted there);
 * - review round 14 (S14-1): in the dev service, any mount at or below CONFIG_FOLDER (configFolderTarget): refused as not
 *   supported (the Git and Docker configuration of the dev container are there, and the ownership fix of the extension
 *   walks the folder in full). The other services do not have the folder (they cannot mount the workspace volume), so
 *   their targets there stay allowed;
 * - review of unit 15: in the dev service, `bind.propagation` shared or rshared at `/` or a parent of the tmpfs of the
 *   token (tokenPropagationTarget): refused whatever the switch says (it would bring the token to the computer).
 */
export function decideServiceMount(entry: unknown, ctx: ComposeMountContext): ComposeEntryDecision {
  if (!isRecord(entry)) return { action: 'refuse', kind: 'unsupported', item: `volume ${JSON.stringify(entry)}` };
  const type = typeof entry.type === 'string' ? entry.type : 'volume';
  const target = normalizedTarget(entry.target);
  const source = typeof entry.source === 'string' ? entry.source : '';
  const describe = `${source || '(anonymous)'} → ${String(entry.target)}`;
  const atWorkspaces = ctx.isDev && target === WORKSPACES_ROOT;
  if (target === undefined) return { action: 'refuse', kind: 'unsupported', item: `volume ${describe} without a target` };
  // Review round 14 (S14-1): only the dev container has the folder (the other services cannot mount the workspace volume).
  const internal = ctx.isDev ? configFolderTarget(target) : undefined;
  if (internal !== undefined) return { action: 'refuse', kind: 'unsupported', item: configFolderMountItem(internal) };
  // Review of unit 15: a shared propagation where the tmpfs of the token would reach the computer, whatever the switch
  // says (tokenPropagationTarget).
  const propagation = isRecord(entry.bind) && typeof entry.bind.propagation === 'string' ? entry.bind.propagation : undefined;
  const shared = ctx.isDev && propagation !== undefined && isSharedPropagation(propagation) ? tokenPropagationTarget(target) : undefined;
  if (shared !== undefined) return { action: 'refuse', kind: 'hostAccess', item: sharedPropagationItem(shared), guarded: true };
  if (type === 'tmpfs') {
    return atWorkspaces ? { action: 'refuse', kind: 'unsupported', item: `mount at ${WORKSPACES_ROOT}` } : { action: 'keep' };
  }
  if (type === 'volume') {
    if (atWorkspaces) return { action: 'refuse', kind: 'unsupported', item: `mount at ${WORKSPACES_ROOT}` };
    if (source === '') return { action: 'keep' };
    const name = ctx.volumeNames.get(source);
    if (name === undefined) return { action: 'refuse', kind: 'unsupported', item: `volume ${source} (not in the top-level volumes)` };
    if (name === ctx.ownVolume && !ctx.isDev) {
      return { action: 'refuse', kind: 'hostAccess', item: `volume ${name} (the workspace volume, with the repository and the Git configuration of the environment)`, guarded: true };
    }
    return { action: 'keep' };
  }
  if (type !== 'bind') return { action: 'refuse', kind: 'unsupported', item: `mount of the type ${type} (${describe})` };
  if (!source.startsWith('/')) {
    return atWorkspaces ? { action: 'refuse', kind: 'unsupported', item: `mount at ${WORKSPACES_ROOT}` } : { action: 'refuse', kind: 'hostAccess', item: `bind mount ${describe}` };
  }
  const lexical = path.posix.normalize(source).replace(/(.)\/+$/, '$1');
  const parent = WORKSPACES_ROOT;
  const repository = ctx.repositoryFolder;
  const readOnly = entry.read_only === true;
  if (atWorkspaces && (lexical === repository || lexical === parent)) {
    return { action: 'drop', reason: 'the workspace volume is mounted there' };
  }
  // Any other folder at WORKSPACES_ROOT of the dev service, also one that the host access checks off would allow: the
  // workspace volume is mounted there.
  if (atWorkspaces) return { action: 'refuse', kind: 'unsupported', item: `mount at ${WORKSPACES_ROOT}` };
  if (lexical === parent) {
    if (!ctx.isDev) {
      return { action: 'refuse', kind: 'hostAccess', item: `bind mount ${describe} (the workspace volume, with the repository and the Git configuration of the environment)`, guarded: true };
    }
    const value: Record<string, unknown> = { type: 'volume', source: WORKSPACE_VOLUME_KEY, target: entry.target };
    if (readOnly) value.read_only = true;
    return { action: 'replace', value, reason: 'the workspace volume in place of the folder' };
  }
  if (!isInside(lexical, repository)) return { action: 'refuse', kind: 'hostAccess', item: `bind mount ${describe}` };
  let createFolder: string | undefined;
  if (ctx.realPaths && Object.prototype.hasOwnProperty.call(ctx.realPaths, source)) {
    const real = ctx.realPaths[source];
    if (real === null) {
      // Review round 8 (P8-2): a folder of the repository that does not exist yet (for example a data folder in
      // .gitignore), which Docker would create (`create_host_path`): created in the workspace volume before `up`, when the
      // nearest folder above it that exists is in the repository after links (ComposeModelOutput.mountAncestors).
      const ancestor = ctx.mountAncestors !== undefined && Object.prototype.hasOwnProperty.call(ctx.mountAncestors, source) ? ctx.mountAncestors[source] : undefined;
      const bind = isRecord(entry.bind) ? entry.bind : {};
      if (typeof ancestor !== 'string' || bind.create_host_path === false) {
        return { action: 'refuse', kind: 'unsupported', item: `bind mount ${describe} (the path does not exist in the repository)` };
      }
      if (!isInside(ancestor, repository) || isHelperPath(ancestor, repository)) {
        return { action: 'refuse', kind: 'hostAccess', item: `bind mount ${describe} (a link to ${ancestor}, outside of the repository)`, guarded: true };
      }
      createFolder = lexical;
    } else if (!isInside(real, repository)) {
      // A subpath of the workspace volume that a link leads out of the repository, for example to the GitHub token: not clear.
      return { action: 'refuse', kind: 'hostAccess', item: `bind mount ${describe} (a link to ${real}, outside of the repository)`, guarded: true };
    }
  }
  if (ctx.engineApiVersion === undefined) {
    // Review round 1 (P-5): an engine that did not tell its version is not an old engine.
    return {
      action: 'refuse',
      kind: 'unsupported',
      item: `bind mount ${describe} (needs ${MIN_SUBPATH_ENGINE} or newer; the version of the Docker Engine could not be read)`,
    };
  }
  if (!supportsVolumeSubpath(ctx.engineApiVersion)) {
    return { action: 'refuse', kind: 'unsupported', item: `bind mount ${describe} (needs ${MIN_SUBPATH_ENGINE} or newer)` };
  }
  const subpath = path.posix.relative(parent, lexical);
  const value: Record<string, unknown> = {
    type: 'volume',
    source: WORKSPACE_VOLUME_KEY,
    target: entry.target,
    volume: { nocopy: true, subpath },
  };
  if (readOnly) value.read_only = true;
  if (createFolder !== undefined) {
    return {
      action: 'replace',
      value,
      reason: `the folder ${subpath} of the workspace volume, created in the repository before the start (the service can read and change these files of the repository)`,
      createFolder,
    };
  }
  return { action: 'replace', value, reason: `the folder ${subpath} of the workspace volume (the service can read and change these files of the repository)` };
}

/**
 * A published port of a service: without an address (`host_ip` missing or empty) it is published on 127.0.0.1 only;
 * a loopback address is kept; any other address is refused (concept section 9: ports reach the computer only on
 * localhost). The long syntax of `docker compose config` is an object; a text (short syntax) is read as `-p`.
 */
export function decideServicePort(entry: unknown): ComposeEntryDecision {
  const reason = 'published on 127.0.0.1 only';
  if (typeof entry === 'string' || typeof entry === 'number') {
    const text = String(entry).trim();
    if (text.includes('=')) return { action: 'refuse', kind: 'unsupported', item: `published port ${text}` };
    const { address } = splitPortAddress(text);
    if (address === undefined || address === '') return { action: 'replace', value: withLoopbackAddress(text), reason };
    return isLoopbackAddress(address) ? { action: 'keep' } : { action: 'refuse', kind: 'hostAccess', item: `published port ${text}` };
  }
  if (!isRecord(entry)) return { action: 'refuse', kind: 'unsupported', item: `published port ${JSON.stringify(entry)}` };
  const hostIp = entry.host_ip;
  if (hostIp === undefined || hostIp === null || hostIp === '') {
    return { action: 'replace', value: { ...entry, host_ip: '127.0.0.1' }, reason };
  }
  if (typeof hostIp === 'string' && isLoopbackAddress(hostIp)) return { action: 'keep' };
  const published = entry.published === undefined || entry.published === null ? '' : String(entry.published);
  return { action: 'refuse', kind: 'hostAccess', item: `published port ${String(hostIp)}:${published}:${String(entry.target)}` };
}
