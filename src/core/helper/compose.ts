// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker Compose configurations (implementation notes, section "Docker Compose"): the merged model that
// `docker compose config --format json` prints in the workspace helper (COMPOSE_MODEL_SCRIPT), and the model that the
// Dev Container CLI runs, which is our rewrite of exactly the checked model (composeUpModel, composeBuildModel): the
// repository's compose files are read once, by the check, so nothing can change between the check and `up`. The rules
// of the check are in composeAccess.ts; the mounts and ports are decided by the same functions here for both.
// Pure functions, no I/O.
import * as crypto from 'crypto';
import * as path from 'path';
import type { ConfigReferences } from '../imageCheck/imageCheck';
import type { HostAccessChecks } from '../hostAccessChecks';
import { extractBaseImages } from '../imageCheck/dockerfile';
import { hasDigest, isOciFeatureReference } from '../imageCheck/reference';
import {
  CONTAINER_VERSION,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_ENVIRONMENT_ID,
  LABEL_HOST_ACCESS,
  WORKSPACES_ROOT,
  containerHostname,
} from '../names';
import { isLoopbackAddress, isPathSource, parseMountString, splitPortAddress, withLoopbackAddress } from './hostAccess';
import { OVERRIDE_FOLDER } from './scripts';

/** A service of the merged model (`services.<name>`), as `docker compose config --format json` prints it. */
export type ComposeService = Record<string, unknown>;

/** The merged model of a Compose configuration (`docker compose config --format json`). */
export interface ComposeModel {
  name?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, Record<string, unknown> | null>;
  networks?: Record<string, Record<string, unknown> | null>;
  [key: string]: unknown;
}

/** The model that we write for the Dev Container CLI: the only compose file of `read-configuration`, `build`, and `up`. */
export const COMPOSE_MODEL_PATH = `${OVERRIDE_FOLDER}/compose.json`;
/** Build context of the synthesized build of an image-only dev service (an empty folder, WRITE_AND_RUN_SCRIPT). */
export const COMPOSE_BUILD_CONTEXT = `${OVERRIDE_FOLDER}/context`;
/** Dockerfile of the synthesized build of the dev service (`FROM <image>`, or its `dockerfile_inline`). */
export const COMPOSE_DEV_DOCKERFILE = `${OVERRIDE_FOLDER}/dev.Dockerfile`;
/** Key of the workspace volume in the top-level `volumes` of our model. The check refuses it in a repository. */
export const WORKSPACE_VOLUME_KEY = 'devenv-workspace';

/**
 * The oldest Compose plugin with the YAML tags `!reset` (2.24.0) and `!override` (2.24.4): the fallback of the
 * implementation notes (the repository's files plus one file of ours) needs them. The helper installs the current plugin.
 */
export const MIN_COMPOSE_VERSION = '2.24.4';

/**
 * The oldest Docker Engine API with `volume.subpath` (API 1.45, Docker Engine 26): a bind mount of repository files is
 * rewritten to a subpath of the workspace volume only with this engine or a newer one.
 */
export const MIN_SUBPATH_API_VERSION = '1.45';
/** The Docker Engine version of MIN_SUBPATH_API_VERSION, for the messages. */
export const MIN_SUBPATH_ENGINE = 'Docker Engine 26';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The numeric parts of a version text (`v2.29.1-desktop.1` → [2, 29, 1]); `undefined` when it starts otherwise. */
function versionParts(version: string): number[] | undefined {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(version.trim());
  return match ? match[1].split('.').map(Number) : undefined;
}

/** Whether version `a` is `b` or newer (missing parts count as 0). */
function atLeast(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Whether the version of the Compose plugin (`docker compose version --short`) is MIN_COMPOSE_VERSION or newer. */
export function isSupportedComposeVersion(version: string): boolean {
  const parts = versionParts(version);
  return parts !== undefined && atLeast(parts, versionParts(MIN_COMPOSE_VERSION)!);
}

/**
 * Whether the Docker Engine API version (`docker version --format '{{.Server.APIVersion}}'`) has `volume.subpath`
 * (MIN_SUBPATH_API_VERSION). `false` when it is not known.
 */
export function supportsVolumeSubpath(apiVersion: string | undefined): boolean {
  const parts = apiVersion === undefined ? undefined : versionParts(apiVersion);
  return parts !== undefined && atLeast(parts, versionParts(MIN_SUBPATH_API_VERSION)!);
}

// ---------------------------------------------------------------------------------------------------------------------
// The compose files of a configuration

/**
 * The compose files of `dockerComposeFile` as absolute paths in the helper. The Dev Container CLI resolves them against
 * the folder of the configuration (CLI 0.89.0, devContainersSpecCLI.js: `function sg(e,A,t){return
 * rj(e,A.configFilePath,t)}` with `nQ.posix.resolve(i.path,…t)`), also when an override configuration replaces it, so
 * the check reads them the same way here, and the override names our model by an absolute path. Each file must be in the
 * repository folder. A missing or empty `dockerComposeFile` is not supported: the CLI would then read `COMPOSE_FILE` of
 * the repository's `.env` or a default file name. `configPath` is relative to the repository folder.
 */
export function resolveComposeFiles(
  configPath: string,
  repositoryName: string,
  dockerComposeFile: unknown,
): { files: string[] } | { problem: string } {
  const repository = `${WORKSPACES_ROOT}/${repositoryName}`;
  const base = path.posix.dirname(path.posix.resolve(repository, configPath));
  const entries = typeof dockerComposeFile === 'string' ? [dockerComposeFile] : dockerComposeFile;
  if (!Array.isArray(entries) || entries.length === 0) return { problem: 'dockerComposeFile without a compose file' };
  const files: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim() === '') return { problem: `dockerComposeFile ${JSON.stringify(entry)}` };
    if (entry.includes('${')) return { problem: `dockerComposeFile ${JSON.stringify(entry)} (a variable that is not resolved)` };
    const file = path.posix.resolve(base, entry);
    if (!file.startsWith(`${repository}/`)) return { problem: `dockerComposeFile ${JSON.stringify(entry)} (outside of the repository)` };
    if (!files.includes(file)) files.push(file);
  }
  return { files };
}

// ---------------------------------------------------------------------------------------------------------------------
// Output of the model run

/** The result of COMPOSE_MODEL_SCRIPT. */
export interface ComposeModelOutput {
  /** `docker compose version --short` in the helper. */
  version: string;
  /**
   * Whether `docker compose config` prints a literal `$` as `$$` (the probe of COMPOSE_MODEL_SCRIPT). When it does not,
   * the values of our model are escaped (escapeComposeDollars), because Compose interpolates the model again.
   */
  dollarEscaped: boolean;
  model: ComposeModel;
  /** The Dockerfile text of each service with a local build, by service name (only files in the repository). */
  dockerfiles: Record<string, string>;
  /**
   * The real path (links resolved) of each bind mount source and `env_file` of the model, as the model names it; `null`
   * for a path that does not exist.
   */
  realPaths: Record<string, string | null>;
}

/**
 * The JSON line of COMPOSE_MODEL_SCRIPT (the last non-empty line of its output): the model, or `{ error }` with the
 * message of Docker Compose (for example a syntax error in a compose file). Throws for any other output.
 */
export function parseComposeModelOutput(stdout: string): ComposeModelOutput | { error: string } {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error('The workspace helper printed no Compose model.');
  let value: unknown;
  try {
    value = JSON.parse(lines[lines.length - 1]);
  } catch {
    throw new Error('The workspace helper printed an invalid Compose model.');
  }
  if (isRecord(value) && typeof value.error === 'string') return { error: value.error };
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    typeof value.dollarEscaped !== 'boolean' ||
    !isRecord(value.model) ||
    !isRecord(value.model.services) ||
    !isRecord(value.dockerfiles) ||
    !Object.values(value.dockerfiles).every((text) => typeof text === 'string') ||
    !isRecord(value.realPaths) ||
    !Object.values(value.realPaths).every((real) => real === null || typeof real === 'string')
  ) {
    throw new Error('The workspace helper printed an invalid Compose model.');
  }
  return {
    version: value.version,
    dollarEscaped: value.dollarEscaped,
    model: value.model as unknown as ComposeModel,
    dockerfiles: value.dockerfiles as Record<string, string>,
    realPaths: value.realPaths as Record<string, string | null>,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Names

/**
 * Name of the image that Compose builds for a service of the project: `<project>-<service>`, lower case, with only
 * `[a-z0-9-]` (image names do not allow every service name). The repository's `image:` of a built service is replaced
 * by it, so that no two environments write the same tag.
 */
export function composeServiceImage(project: string, service: string): string {
  const name = service.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${project}-${name || 'service'}`;
}

/** A volume or network name of the Compose project of another environment: `devenv-<8 hex>_…`, not `<project>_…`. */
export function isOtherEnvironmentProjectName(name: string, project: string): boolean {
  return /^devenv-[0-9a-f]{8}_/i.test(name) && !name.startsWith(`${project}_`);
}

/** A named volume of the top-level `volumes` of a model. */
export interface ComposeVolumeName {
  /** The key in the model. */
  key: string;
  /** The name of the volume in Docker. */
  name: string;
  /** A volume of the project (`<project>_<key>`): its kind is VOLUME_KIND_COMPOSE; other named volumes are `additional`. */
  project: boolean;
}

/** The Docker name of the top-level volume `key`: its `name`, the key of an external volume, or `<project>_<key>`. */
function volumeNameOf(key: string, volume: Record<string, unknown> | null | undefined, project: string): string {
  if (isRecord(volume) && typeof volume.name === 'string' && volume.name !== '') return volume.name;
  if (isRecord(volume) && volume.external) return key;
  return `${project}_${key}`;
}

/**
 * The named volumes of the top-level `volumes` of the model, with their Docker names: the volumes that the pipeline
 * creates before `up` with the labels of the environment (all of them are external in our model) and whose labels the
 * check reads.
 */
export function composeVolumeNames(model: ComposeModel, project: string): ComposeVolumeName[] {
  const volumes = isRecord(model.volumes) ? model.volumes : {};
  return Object.entries(volumes).map(([key, volume]) => {
    const name = volumeNameOf(key, volume, project);
    const external = isRecord(volume) && Boolean(volume.external);
    return { key, name, project: !external && name === `${project}_${key}` };
  });
}

/**
 * The Docker name of a named volume of a `mounts` entry of devcontainer.json or a Feature in a Compose configuration:
 * the Dev Container CLI adds it to the top-level `volumes` of its generated compose file (CLI 0.89.0, function `oW`:
 * `${e.source}:` plus `external: true` only when the mount object says so, for the mounts with `b.type==="volume"&&b.source`
 * of function `iW`), so Compose names it `<project>_<source>`. `undefined` for other mounts.
 */
export function composeMountVolumeName(project: string, mount: unknown): string | undefined {
  let type: string | undefined;
  let source: string | undefined;
  let external = false;
  if (typeof mount === 'string') {
    const parsed = parseMountString(mount);
    type = parsed.type;
    source = parsed.source;
  } else if (isRecord(mount)) {
    type = typeof mount.type === 'string' ? mount.type.toLowerCase() : undefined;
    source = typeof mount.source === 'string' ? mount.source : undefined;
    external = mount.external === true;
  }
  if (type !== 'volume' || !source || isPathSource(source)) return undefined;
  return external ? source : `${project}_${source}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// References, hash, images

/**
 * The references of the image check: the `image` of each service without a local build, the FROM images of each
 * service with a local build (its Dockerfile of `dockerfiles`, with `build.args` and `build.target`), and the Feature
 * keys that are OCI references. A service with a remote build context has no Dockerfile here and is not checked.
 * References with a digest are skipped, as in collectReferences.
 */
export function composeReferences(model: ComposeModel, dockerfiles: Readonly<Record<string, string>>, features: unknown): ConfigReferences {
  const images: string[] = [];
  for (const [name, service] of Object.entries(model.services)) {
    if (!isRecord(service)) continue;
    const build = isRecord(service.build) ? service.build : undefined;
    if (build) {
      const text = dockerfiles[name];
      if (text === undefined) continue;
      const args: Record<string, string> = {};
      if (isRecord(build.args)) {
        for (const [arg, value] of Object.entries(build.args)) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') args[arg] = String(value);
        }
      }
      const target = typeof build.target === 'string' && build.target !== '' ? build.target : undefined;
      images.push(...extractBaseImages(text, args, { target }));
    } else if (typeof service.image === 'string' && service.image.trim() !== '') {
      images.push(service.image.trim());
    }
  }
  const featureKeys = isRecord(features) ? Object.keys(features).filter(isOciFeatureReference) : [];
  const unique = (values: string[]) => [...new Set(values.filter((value) => !hasDigest(value)))];
  return { images: unique(images), features: unique(featureKeys) };
}

/** JSON with the keys of every object sorted, so that the same model always gives the same text. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * `configHash` of the build record of a Compose configuration: sha256 of the devcontainer.json text, the merged model
 * (keys sorted), and the Dockerfiles of the built services (by service name). A change of any compose file, `.env`
 * value, or Dockerfile that changes what Compose runs changes it.
 */
export function composeConfigHash(configText: string, model: ComposeModel, dockerfiles: Readonly<Record<string, string>>): string {
  const files = Object.keys(dockerfiles)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${JSON.stringify(dockerfiles[name])}`)
    .join(',');
  const text = `${configText}\n${stableJson(model)}\n${files}`;
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

/**
 * The images that Compose and the Dev Container CLI build for the environment (Delete removes them): `<project>-<service>`
 * of each service with a `build`, and of the dev service, which the build model always builds (composeBuildModel).
 */
export function builtServiceImages(model: ComposeModel, project: string, devService: string): string[] {
  const images = new Set<string>();
  for (const [name, service] of Object.entries(model.services)) {
    if (name === devService || (isRecord(service) && service.build !== undefined && service.build !== null)) {
      images.add(composeServiceImage(project, name));
    }
  }
  return [...images].sort();
}

/** `['--user', <user>]` when the dev service names a user (for the owner of the files, prepareOwnership), else `[]`. */
export function composeUserArgs(service: ComposeService | undefined): string[] {
  const user = service?.user;
  return typeof user === 'string' && user.trim() !== '' ? ['--user', user] : [];
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
  | { action: 'replace'; value: unknown; reason: string }
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
 * - in the dev service, any other mount at WORKSPACES_ROOT: refused (the workspace volume is mounted there).
 */
export function decideServiceMount(entry: unknown, ctx: ComposeMountContext): ComposeEntryDecision {
  if (!isRecord(entry)) return { action: 'refuse', kind: 'unsupported', item: `volume ${JSON.stringify(entry)}` };
  const type = typeof entry.type === 'string' ? entry.type : 'volume';
  const target = normalizedTarget(entry.target);
  const source = typeof entry.source === 'string' ? entry.source : '';
  const describe = `${source || '(anonymous)'} → ${String(entry.target)}`;
  const atWorkspaces = ctx.isDev && target === WORKSPACES_ROOT;
  if (target === undefined) return { action: 'refuse', kind: 'unsupported', item: `volume ${describe} without a target` };
  if (type === 'tmpfs') {
    return atWorkspaces ? { action: 'refuse', kind: 'unsupported', item: `mount at ${WORKSPACES_ROOT}` } : { action: 'keep' };
  }
  if (type === 'volume') {
    if (atWorkspaces) return { action: 'refuse', kind: 'unsupported', item: `mount at ${WORKSPACES_ROOT}` };
    if (source === '') return { action: 'keep' };
    const name = ctx.volumeNames.get(source);
    if (name === undefined) return { action: 'refuse', kind: 'unsupported', item: `volume ${source} (not in the top-level volumes)` };
    if (name === ctx.ownVolume && !ctx.isDev) {
      return { action: 'refuse', kind: 'hostAccess', item: `volume ${name} (the workspace volume, which holds the GitHub token)`, guarded: true };
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
      return { action: 'refuse', kind: 'hostAccess', item: `bind mount ${describe} (the workspace volume, which holds the GitHub token)`, guarded: true };
    }
    const value: Record<string, unknown> = { type: 'volume', source: WORKSPACE_VOLUME_KEY, target: entry.target };
    if (readOnly) value.read_only = true;
    return { action: 'replace', value, reason: 'the workspace volume in place of the folder' };
  }
  if (!isInside(lexical, repository)) return { action: 'refuse', kind: 'hostAccess', item: `bind mount ${describe}` };
  if (ctx.realPaths && Object.prototype.hasOwnProperty.call(ctx.realPaths, source)) {
    const real = ctx.realPaths[source];
    if (real === null) {
      return { action: 'refuse', kind: 'unsupported', item: `bind mount ${describe} (the path does not exist in the repository)` };
    }
    if (!isInside(real, repository)) {
      // A subpath of the workspace volume that a link leads out of the repository, for example to the GitHub token: not clear.
      return { action: 'refuse', kind: 'hostAccess', item: `bind mount ${describe} (a link to ${real}, outside of the repository)`, guarded: true };
    }
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

// ---------------------------------------------------------------------------------------------------------------------
// The model that runs

/** What the rewrite needs to know about the environment. */
export interface ComposeRewriteParams {
  /** composeProjectName of the environment. */
  project: string;
  /** `service` of devcontainer.json. */
  devService: string;
  environmentId: string;
  /** The name of the dev container (the name of the environment). */
  containerName: string;
  /** The workspace volume. */
  volumeName: string;
  /** The folder of the repository in the helper, for example `/workspaces/api`. */
  repositoryFolder: string;
  /** ComposeModelOutput.dollarEscaped. */
  dollarEscaped: boolean;
  /** See ComposeMountContext.engineApiVersion. */
  engineApiVersion?: string;
  /** ComposeModelOutput.realPaths. */
  realPaths?: Readonly<Record<string, string | null>>;
  /**
   * The sources of the named volumes of the `mounts` of devcontainer.json and of the Features: declared as external
   * volumes `<project>_<source>` (composeMountVolumeName), which the pipeline creates with the labels of the
   * environment, so Compose creates none without them.
   */
  mountVolumeSources?: readonly string[];
  /**
   * The switch of the host access checks of the repository (../hostAccessChecks.ts), as the check used it. `off`: the
   * published ports keep the address that the model gives them, the mounts that only the class `computer` refuses stay
   * as they are, and every container gets the label devenv.host-access=unrestricted (containerIsCurrent). Default `on`.
   */
  hostAccessChecks?: HostAccessChecks;
}

/** A change of the rewrite, for the log: what, and why. */
export interface ComposeRewrite {
  item: string;
  reason: string;
}

/** The result of composeUpModel. */
export interface ComposeModelRewrite {
  model: ComposeModel;
  rewrites: ComposeRewrite[];
}

/** The model is our rewrite of a model that the check refused: the pipeline checks before it rewrites. */
function notChecked(item: string): Error {
  return new Error(`The Compose model has a setting that the host access policy refuses: ${item}`);
}

/** `$` → `$$` in every text of a value (not in the keys): Compose then reads the texts as they are. */
export function escapeComposeDollars(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\$/g, '$$$$');
  if (Array.isArray(value)) return value.map(escapeComposeDollars);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, escapeComposeDollars(entry)]));
  return value;
}

/** The text that a value of the model stands for: `$$` → `$` when the output escapes it. */
function literal(text: string, dollarEscaped: boolean): string {
  return dollarEscaped ? text.replace(/\$\$/g, '$') : text;
}

/** Labels in the map form (`docker compose config` prints a map; a list `KEY=value` is read too). */
function labelMap(labels: unknown): Record<string, string> {
  if (isRecord(labels)) {
    return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, value === null || value === undefined ? '' : String(value)]));
  }
  if (Array.isArray(labels)) {
    const map: Record<string, string> = {};
    for (const entry of labels) {
      const text = String(entry);
      const index = text.indexOf('=');
      map[index < 0 ? text : text.slice(0, index)] = index < 0 ? '' : text.slice(index + 1);
    }
    return map;
  }
  return {};
}

function mountContext(model: ComposeModel, p: ComposeRewriteParams, isDev: boolean): ComposeMountContext {
  const volumeNames = new Map(composeVolumeNames(model, p.project).map((volume) => [volume.key, volume.name]));
  return {
    isDev,
    repositoryFolder: p.repositoryFolder,
    volumeNames,
    ownVolume: p.volumeName,
    engineApiVersion: p.engineApiVersion,
    realPaths: p.realPaths,
  };
}

/** The rewrites that the up model and the build model share. */
function rewriteModel(source: ComposeModel, p: ComposeRewriteParams): { model: ComposeModel; rewrites: ComposeRewrite[] } {
  const rewrites: ComposeRewrite[] = [];
  const model = JSON.parse(JSON.stringify(source)) as ComposeModel;
  if (!isRecord(model.services[p.devService])) throw new Error(`The Compose configuration has no service ${p.devService}.`);
  if (model.name !== undefined && model.name !== p.project) {
    rewrites.push({ item: `project name ${String(model.name)}`, reason: `the project of the environment is ${p.project}` });
  }
  model.name = p.project;
  const checksOn = p.hostAccessChecks !== 'off';
  // With the checks off, a refusal of the class `computer` is no refusal: the entry stays as the model has it.
  const lifted = (decision: ComposeEntryDecision): boolean =>
    !checksOn && decision.action === 'refuse' && decision.kind === 'hostAccess' && decision.guarded !== true;
  for (const [name, service] of Object.entries(model.services)) {
    if (!isRecord(service)) throw notChecked(`service ${name}`);
    const isDev = name === p.devService;
    const at = `service ${name}: `;
    // Labels: every container of the project carries the environment ID (Stop, the Session Monitor, Delete).
    const labels = labelMap(service.labels);
    labels[LABEL_ENVIRONMENT_ID] = p.environmentId;
    if (isDev) labels[LABEL_CONTAINER_VERSION] = String(CONTAINER_VERSION);
    else labels[LABEL_COMPOSE_SERVICE] = name;
    // Created while the host access checks were off: not current once they are on again (containerIsCurrent).
    if (!checksOn) labels[LABEL_HOST_ACCESS] = HOST_ACCESS_UNRESTRICTED;
    service.labels = labels;
    // Names: the dev container has the name of the environment; the others the default names of Compose (a fixed name
    // would collide between two environments of one repository).
    if (isDev) {
      if (typeof service.container_name === 'string' && service.container_name !== p.containerName) {
        rewrites.push({ item: `${at}container_name ${service.container_name}`, reason: `the container gets the name of the environment, ${p.containerName}` });
      }
      service.container_name = p.containerName;
    } else if (service.container_name !== undefined && service.container_name !== null) {
      rewrites.push({ item: `${at}container_name ${String(service.container_name)}`, reason: 'removed: two environments of one repository would use the same name' });
      delete service.container_name;
    }
    // Published ports: on 127.0.0.1 only (with the checks off: as the model has them).
    if (Array.isArray(service.ports)) {
      service.ports = service.ports.map((entry) => {
        const decision = decideServicePort(entry);
        if (!checksOn && (decision.action === 'replace' || lifted(decision))) return entry;
        if (decision.action === 'refuse') throw notChecked(`${at}${decision.item}`);
        if (decision.action !== 'replace') return entry;
        rewrites.push({ item: `${at}port ${portText(entry)}`, reason: decision.reason });
        return decision.value;
      });
    }
    // Mounts: the workspace volume for the dev service; repository files from the workspace volume.
    const ctx = mountContext(source, p, isDev);
    const volumes: unknown[] = [];
    for (const entry of Array.isArray(service.volumes) ? service.volumes : []) {
      const decision = decideServiceMount(entry, ctx);
      if (decision.action === 'refuse' && !lifted(decision)) throw notChecked(`${at}${decision.item}`);
      if (decision.action === 'keep' || decision.action === 'refuse') {
        volumes.push(entry);
        continue;
      }
      rewrites.push({ item: `${at}bind mount ${mountText(entry)}`, reason: decision.reason });
      if (decision.action === 'replace') volumes.push(decision.value);
    }
    if (isDev) volumes.unshift({ type: 'volume', source: WORKSPACE_VOLUME_KEY, target: WORKSPACES_ROOT });
    if (volumes.length > 0) service.volumes = volumes;
    else delete service.volumes;
    // Pulls: the pipeline pulls with the credentials of the image check before `up`; Compose pulls in the helper only
    // what is missing, and never the environment image (D-16).
    const pullPolicy = isDev ? 'never' : 'missing';
    if (typeof service.pull_policy === 'string' && service.pull_policy !== pullPolicy) {
      rewrites.push({ item: `${at}pull_policy ${service.pull_policy}`, reason: `Dev Environments pulls the images itself (${pullPolicy})` });
    }
    service.pull_policy = pullPolicy;
    // Images that Compose builds: the name of the project, never a name that another environment could use too.
    if (!isDev && isRecord(service.build)) {
      const image = composeServiceImage(p.project, name);
      if (typeof service.image === 'string' && service.image !== image) {
        rewrites.push({ item: `${at}image ${service.image}`, reason: `the built image is named ${image}` });
      }
      service.image = image;
    }
  }
  // Volumes: all external; the pipeline creates them before `up` with the labels of the environment (D-7).
  const volumes: Record<string, Record<string, unknown>> = {};
  for (const volume of composeVolumeNames(source, p.project)) volumes[volume.key] = { name: volume.name, external: true };
  for (const mountSource of p.mountVolumeSources ?? []) {
    if (!Object.prototype.hasOwnProperty.call(volumes, mountSource)) volumes[mountSource] = { name: `${p.project}_${mountSource}`, external: true };
  }
  volumes[WORKSPACE_VOLUME_KEY] = { name: p.volumeName, external: true };
  model.volumes = volumes;
  return { model, rewrites };
}

function portText(entry: unknown): string {
  if (!isRecord(entry)) return String(entry);
  const published = entry.published === undefined || entry.published === null ? '' : `${String(entry.published)}:`;
  return `${published}${String(entry.target)}${entry.protocol && entry.protocol !== 'tcp' ? `/${String(entry.protocol)}` : ''}`;
}

function mountText(entry: unknown): string {
  return isRecord(entry) ? `${String(entry.source)} → ${String(entry.target)}` : String(entry);
}

function finish(model: ComposeModel, dollarEscaped: boolean): ComposeModel {
  return dollarEscaped ? model : (escapeComposeDollars(model) as ComposeModel);
}

/**
 * The model of `devcontainer up` (the only compose file of the override configuration, COMPOSE_MODEL_PATH), from the
 * checked merged model:
 * - `name`: the project of the environment;
 * - every service: the label devenv.environment-id, published ports on 127.0.0.1 only (decideServicePort), mounts of
 *   repository files from the workspace volume (decideServiceMount), `pull_policy: missing`;
 * - the other services: the label devenv.compose-service, no `container_name` (D-12), `image: <project>-<service>` when
 *   Compose builds them;
 * - the dev service: the environment image (`image`, no `build`, `pull_policy: never`), the name of the environment
 *   (`container_name`), the label devenv.container-version, the workspace volume at WORKSPACES_ROOT (the templates'
 *   bind mount there is dropped), and the host name of the repository (containerHostname) unless the service decides
 *   it (serviceDecidesHostname);
 * - top-level `volumes`: each external, with its Docker name, plus the workspace volume (WORKSPACE_VOLUME_KEY) and the
 *   volumes of `mountVolumeSources`;
 * - with the host access checks off (`hostAccessChecks`): the label devenv.host-access=unrestricted on every service,
 *   the published ports as the model has them, and the mounts that only the class `computer` refuses unchanged;
 * - each text escaped (`$$`) when the output of `docker compose config` does not escape it.
 * `network_mode: service:<name>` stays as it is: the check allows only a service of the same model, which Compose
 * finds by its service name, not by the removed `container_name`. Throws when the model has a setting that the check
 * refuses (composeAccessReport must pass first). `rewrites` names each change for the log.
 */
export function composeUpModel(model: ComposeModel, p: ComposeRewriteParams & { image: string }): ComposeModelRewrite {
  const { model: result, rewrites } = rewriteModel(model, p);
  const dev = result.services[p.devService];
  if (dev.build !== undefined && dev.build !== null) rewrites.push({ item: `service ${p.devService}: build`, reason: `the environment image ${p.image} is used` });
  delete dev.build;
  dev.image = p.image;
  // Without it, Docker names the host after the container ID, and the shell prompt shows that ID (as for a single
  // container, buildOverrideConfig). The other services keep theirs.
  if (!serviceDecidesHostname(dev)) dev.hostname = containerHostname(path.posix.basename(p.repositoryFolder));
  return { model: finish(result, p.dollarEscaped), rewrites };
}

/**
 * Whether a service decides the host name of its container itself (the counterpart of runArgsDecideHostname): with
 * `hostname`; with the network of another service or container (`network_mode: service:…`/`container:…`) or `uts: host`,
 * where Docker refuses a host name; or with `network_mode: host`, where the container keeps the host name of the
 * computer. The up model then sets no `hostname`.
 */
export function serviceDecidesHostname(service: ComposeService): boolean {
  if (typeof service.hostname === 'string' && service.hostname.trim() !== '') return true;
  const network = typeof service.network_mode === 'string' ? service.network_mode.trim().toLowerCase() : '';
  if (network === 'host' || network.startsWith('service:') || network.startsWith('container:')) return true;
  return typeof service.uts === 'string' && service.uts.trim().toLowerCase() === 'host';
}

/** The result of composeBuildModel: the model, and the Dockerfile of the dev service to write at COMPOSE_DEV_DOCKERFILE. */
export interface ComposeBuildModelRewrite extends ComposeModelRewrite {
  devDockerfile?: string;
}

/**
 * The model of `devcontainer build --image-name <environment image>` (and of `read-configuration`): the rewrites of
 * composeUpModel for every service, and for the dev service a build of its own image `<project>-<service>`, which the
 * CLI then tags as the environment image (CLI 0.89.0, `build`: `OA=mA||RA.image||mp(…)` … `Oe(q,"tag",OA,bA)`):
 * - with a `build` in the repository: that build (with `dockerfile_inline` written to COMPOSE_DEV_DOCKERFILE, because the
 *   CLI reads the Dockerfile itself and knows only `build.dockerfile`: function `lp`, `dockerfilePath:r.dockerfile??"Dockerfile"`);
 * - image-only: a synthesized build `FROM <image>` (D-8). Otherwise the CLI names the image of the Features
 *   `vsc-<repository folder name>-<hash of the folder>` (function `Go`), the same name for every environment of a
 *   repository with that name, and a concurrent build of another environment could move the tag.
 * The CLI resolves a relative `dockerfile` against the context (`f.path.isAbsolute(CA)?CA:SG.default.resolve(uA,CA)`);
 * ours are absolute. Throws like composeUpModel.
 */
export function composeBuildModel(model: ComposeModel, p: ComposeRewriteParams): ComposeBuildModelRewrite {
  const { model: result, rewrites } = rewriteModel(model, p);
  const dev = result.services[p.devService];
  const image = composeServiceImage(p.project, p.devService);
  let devDockerfile: string | undefined;
  if (isRecord(dev.build)) {
    if (typeof dev.build.dockerfile_inline === 'string') {
      devDockerfile = literal(dev.build.dockerfile_inline, p.dollarEscaped);
      delete dev.build.dockerfile_inline;
      dev.build.dockerfile = COMPOSE_DEV_DOCKERFILE;
    }
  } else if (typeof dev.image === 'string' && dev.image.trim() !== '') {
    devDockerfile = `FROM ${literal(dev.image.trim(), p.dollarEscaped)}\n`;
    dev.build = { context: COMPOSE_BUILD_CONTEXT, dockerfile: COMPOSE_DEV_DOCKERFILE };
  } else {
    throw notChecked(`service ${p.devService}: no image and no build`);
  }
  dev.image = image;
  const escaped = finish(result, p.dollarEscaped);
  return devDockerfile === undefined ? { model: escaped, rewrites } : { model: escaped, rewrites, devDockerfile };
}
