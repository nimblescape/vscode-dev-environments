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
import { buildArgumentTexts, extractBaseImages } from '../imageCheck/dockerfile';
import { hasDigest, isOciFeatureReference } from '../imageCheck/reference';
import {
  CONTAINER_VERSION,
  HOST_ACCESS_CHECKED,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_ENVIRONMENT_ID,
  LABEL_CONFIG_PATH,
  LABEL_HOST_ACCESS,
  TOKEN_TMPFS,
  WORKSPACES_ROOT,
  containerHostname,
  isConfigPathLabelValue,
} from '../names';
import {
  isDockerNetworkMode,
  configFolderMountItem,
  configFolderTarget,
  isHelperPath,
  isLoopbackAddress,
  isOtherEnvironmentProjectName,
  isPathSource,
  MAX_STOP_TIMEOUT_SECONDS,
  parseMountString,
  splitPortAddress,
  withLoopbackAddress,
} from './hostAccess';
import { MAX_ANALYSIS_JOB_CHARACTERS, MAX_COMPOSE_MOUNTS, MAX_COMPOSE_SERVICES, MAX_COMPOSE_TOP_LEVEL_ENTRIES } from './analysisLimits';
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
/**
 * Dockerfile of the build of the dev service: the checked text of its Dockerfile (review round 20, P20-1: also of a
 * file of the repository), its `dockerfile_inline`, or the synthesized `FROM <image>`.
 */
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
   * Whether `docker compose config` prints a literal `$` as `$$` (the probe of COMPOSE_MODEL_SCRIPT). Review round 19
   * (S19-1): either way `model` holds the unescaped texts (COMPOSE_MODEL_SCRIPT unescapes them), and the values of our
   * models are always escaped (escapeComposeDollars), because Compose interpolates the model again.
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
  /**
   * Review round 3 (P3-1): the local build contexts and Dockerfiles in the repository that do not exist, without a link
   * that leads to or through them (a missing file of the repository, not a link out). Missing in older outputs.
   */
  missing?: string[];
  /**
   * Review round 8 (P8-2): of each bind mount source in the repository that does not exist (realPaths `null`), the real
   * path of the nearest path above it (or itself, a link that leads nowhere) that exists, when that is a folder; `null`
   * when it is no folder or cannot be read. Missing in older outputs.
   */
  mountAncestors?: Record<string, string | null>;
  /**
   * Review round 10 (D10-2): of each source of mountAncestors whose nearest path is a folder, where the folder lands when
   * the pipeline creates it (CREATE_FOLDERS_SCRIPT, which follows links like the system): the real path of that nearest
   * folder plus the rest of the path. Missing in older outputs.
   */
  mountCreateTargets?: Record<string, string>;
  /**
   * sha256 of the texts of the files that Compose read for the model (the compose files, the `.env` of the project
   * folder, the `env_file`s), computed in the helper (review round 1, P-4); `''` when the output has none.
   */
  inputsHash: string;
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
  // Review round 9 (S9-2): the text of each Dockerfile once (dockerfileTexts, by path), named by the services
  // (dockerfileFiles); every service gets the same string, not a copy.
  if (isRecord(value) && isRecord(value.dockerfiles) && (value.dockerfileFiles !== undefined || value.dockerfileTexts !== undefined)) {
    const files = value.dockerfileFiles;
    const texts = value.dockerfileTexts;
    if (!isRecord(files) || !isRecord(texts)) throw new Error('The workspace helper printed an invalid Compose model.');
    const dockerfiles: Record<string, unknown> = { ...value.dockerfiles };
    for (const [service, file] of Object.entries(files)) {
      if (typeof file !== 'string' || !Object.prototype.hasOwnProperty.call(texts, file)) throw new Error('The workspace helper printed an invalid Compose model.');
      if (!Object.prototype.hasOwnProperty.call(dockerfiles, service)) dockerfiles[service] = texts[file];
    }
    value.dockerfiles = dockerfiles;
  }
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
    // Review round 8 (P8-2): only the entries that are a path or null.
    ...(isRecord(value.mountAncestors)
      ? { mountAncestors: Object.fromEntries(Object.entries(value.mountAncestors).filter(([, real]) => real === null || typeof real === 'string')) as Record<string, string | null> }
      : {}),
    // Review round 10 (D10-2): only the entries that are a path.
    ...(isRecord(value.mountCreateTargets)
      ? { mountCreateTargets: Object.fromEntries(Object.entries(value.mountCreateTargets).filter(([, real]) => typeof real === 'string')) as Record<string, string> }
      : {}),
    ...(Array.isArray(value.missing) ? { missing: value.missing.filter((file): file is string => typeof file === 'string') } : {}),
    inputsHash: typeof value.inputsHash === 'string' ? value.inputsHash : '',
  };
}

/** Review round 10 (S10-1): the keyed top-level maps of a model whose entries composeModelLimit counts. */
const COMPOSE_TOP_LEVEL_MAPS = ['volumes', 'networks', 'configs', 'secrets'] as const;

/**
 * Review round 9 (S9-1): why a model is beyond the limits of the extension host (MAX_COMPOSE_SERVICES services,
 * MAX_COMPOSE_MOUNTS mounts of all services together), or `undefined`. Counted without a copy; the pipeline refuses such
 * a model as too large or too complex before any other work on it. Review round 10: also more than
 * MAX_COMPOSE_TOP_LEVEL_ENTRIES entries of a top-level `volumes`, `networks`, `configs`, or `secrets` (S10-1), and, with
 * the Dockerfiles of the services (ComposeModelOutput.dockerfiles), more than MAX_ANALYSIS_JOB_CHARACTERS characters of
 * them over all services, a shared text once per service as the hashes and the analysis job read it (S10-2).
 */
export function composeModelLimit(model: ComposeModel, dockerfiles?: Readonly<Record<string, string>>): string | undefined {
  const services = isRecord(model.services) ? Object.values(model.services) : [];
  if (services.length > MAX_COMPOSE_SERVICES) return `${services.length} services (at most ${MAX_COMPOSE_SERVICES})`;
  let mounts = 0;
  for (const service of services) {
    if (isRecord(service) && Array.isArray(service.volumes)) mounts += service.volumes.length;
  }
  if (mounts > MAX_COMPOSE_MOUNTS) return `${mounts} mounts (at most ${MAX_COMPOSE_MOUNTS})`;
  for (const key of COMPOSE_TOP_LEVEL_MAPS) {
    const map: unknown = model[key];
    // Counted with a loop that stops at the limit, not with Object.keys (a copy).
    let entries = 0;
    if (isRecord(map)) {
      for (const name in map) {
        if (Object.prototype.hasOwnProperty.call(map, name) && ++entries > MAX_COMPOSE_TOP_LEVEL_ENTRIES) break;
      }
    }
    if (entries > MAX_COMPOSE_TOP_LEVEL_ENTRIES) {
      return `${Object.keys(map as Record<string, unknown>).length} top-level ${key} (at most ${MAX_COMPOSE_TOP_LEVEL_ENTRIES})`;
    }
  }
  let characters = 0;
  for (const name in dockerfiles ?? {}) {
    const text = dockerfiles?.[name];
    if (typeof text === 'string') characters += text.length;
    if (characters > MAX_ANALYSIS_JOB_CHARACTERS) return `more than ${MAX_ANALYSIS_JOB_CHARACTERS} characters of Dockerfiles of the services`;
  }
  return undefined;
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

export { isOtherEnvironmentProjectName };

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

/** A network of the top-level `networks` of a model, with its Docker name. */
export interface ComposeNetworkName {
  key: string;
  name: string;
}

/** The Docker names of the top-level networks of the model: `name`, the key of an external network, or `<project>_<key>`. */
export function composeNetworkNames(model: ComposeModel, project: string): ComposeNetworkName[] {
  const networks = isRecord(model.networks) ? model.networks : {};
  return Object.entries(networks).map(([key, network]) => ({ key, name: volumeNameOf(key, network, project) }));
}

/**
 * The networks of the model that may exist before `up` and whose labels and containers the check reads (S2): the
 * top-level networks (composeNetworkNames) and each network that a `network_mode` names (not a mode of Docker such as
 * `host`, `none`, `service:…`).
 */
export function composeNetworkReferences(model: ComposeModel, project: string): string[] {
  const names = new Set(composeNetworkNames(model, project).map((network) => network.name));
  for (const service of Object.values(isRecord(model.services) ? model.services : {})) {
    const mode = isRecord(service) && typeof service.network_mode === 'string' ? service.network_mode.trim() : '';
    if (mode !== '' && !isDockerNetworkMode(mode)) names.add(mode);
  }
  return [...names];
}

/**
 * The Docker names of the named volumes that services other than the dev service mount (review round 1, D1): they hold
 * the data of the services (for example of a database), whatever their key or `name:`. Delete lists them apart, none
 * ticked (removableServiceDataVolumes of the pipeline).
 */
export function composeServiceVolumeNames(model: ComposeModel, project: string, devService: string): string[] {
  const names = new Map(composeVolumeNames(model, project).map((volume) => [volume.key, volume.name]));
  const used = new Set<string>();
  for (const [service, value] of Object.entries(isRecord(model.services) ? model.services : {})) {
    if (service === devService || !isRecord(value) || !Array.isArray(value.volumes)) continue;
    for (const entry of value.volumes) {
      if (!isRecord(entry) || (entry.type !== undefined && entry.type !== 'volume') || typeof entry.source !== 'string') continue;
      const name = names.get(entry.source);
      if (name !== undefined) used.add(name);
    }
  }
  return [...used].sort();
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
      // Review round 18 (S18-1): own properties, also for an argument named `__proto__`.
      const args = buildArgumentTexts(build.args);
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

/**
 * The `image` of each service other than the dev service that has no `build` (review round 1, D5): images that Compose
 * runs as they are (for example `postgres:16`), which the image check checks and the pipeline pulls, but which are no
 * base image of the environment image. Trimmed, as composeReferences names them.
 */
export function composeServiceImageReferences(model: ComposeModel, devService: string): string[] {
  const images = new Set<string>();
  for (const [name, service] of Object.entries(model.services)) {
    if (name === devService || !isRecord(service) || isRecord(service.build)) continue;
    if (typeof service.image === 'string' && service.image.trim() !== '') images.add(service.image.trim());
  }
  return [...images].sort();
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
  const hash = crypto.createHash('sha256').update(`${configText}\n${stableJson(model)}\n`);
  return `sha256:${updateDockerfiles(hash, dockerfiles).digest('hex')}`;
}

/**
 * Review round 10 (S10-2): feeds `"<service>":<JSON of its Dockerfile text>` of each service (sorted by name, joined by
 * `,`) to `hash`, the same bytes as the text that the hashes joined before (their digests do not change), piece by
 * piece, and the JSON of each distinct text once: many services share one Dockerfile (parseComposeModelOutput).
 */
function updateDockerfiles(hash: crypto.Hash, dockerfiles: Readonly<Record<string, string>>): crypto.Hash {
  const json = new Map<string, string>();
  Object.keys(dockerfiles)
    .sort()
    .forEach((name, index) => {
      const text = dockerfiles[name];
      let value = json.get(text);
      if (value === undefined) {
        value = JSON.stringify(text);
        json.set(text, value);
      }
      hash.update(`${index > 0 ? ',' : ''}${JSON.stringify(name)}:`).update(value);
    });
  return hash;
}

/**
 * The hash of the files of a Compose configuration as written (review round 1, P-4): the devcontainer.json text, the
 * files that Compose read (ComposeModelOutput.inputsHash: compose files, `.env`, `env_file`s), and the Dockerfiles of
 * the built services. Unlike composeConfigHash, it does not depend on the version of the Compose plugin, which prints
 * the same files as a different model now and then.
 */
export function composeInputsHash(configText: string, inputsHash: string, dockerfiles: Readonly<Record<string, string>>): string {
  const hash = crypto.createHash('sha256').update(`${configText}\n${inputsHash}\n`);
  return `sha256:${updateDockerfiles(hash, dockerfiles).digest('hex')}`;
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
 *   supported (the token and the Git configuration of the extension are there, and its ownership fix walks the folder in
 *   full). The other services do not have the folder (they cannot mount the workspace volume), so their targets there
 *   stay allowed.
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
  /**
   * Review round 20 (P20-1): ComposeModelOutput.dockerfiles, the checked Dockerfile texts. composeBuildModel writes the
   * one of the dev service to COMPOSE_DEV_DOCKERFILE, and refuses a local build of it without one.
   */
  dockerfiles?: Readonly<Record<string, string>>;
  /** See ComposeMountContext.engineApiVersion. */
  engineApiVersion?: string;
  /** ComposeModelOutput.realPaths. */
  realPaths?: Readonly<Record<string, string | null>>;
  /** ComposeModelOutput.mountAncestors (review round 8, P8-2). */
  mountAncestors?: Readonly<Record<string, string | null>>;
  /** ComposeModelOutput.mountCreateTargets (review round 10, D10-2). */
  mountCreateTargets?: Readonly<Record<string, string>>;
  /**
   * The sources of the named volumes of the `mounts` of devcontainer.json and of the Features: declared as external
   * volumes `<project>_<source>` (composeMountVolumeName), which the pipeline creates with the labels of the
   * environment, so Compose creates none without them.
   */
  mountVolumeSources?: readonly string[];
  /**
   * The switch of the host access checks of the repository (../hostAccessChecks.ts), as the check used it. `off`: the
   * published ports keep the address that the model gives them, the mounts that only the class `computer` refuses stay
   * as they are, and every container gets the label devenv.host-access=unrestricted (containerIsCurrent); with the checks
   * on, `checked`. Default `on`.
   */
  hostAccessChecks?: HostAccessChecks;
  /**
   * Review round 4 (D4-2): the configuration path of the environment, as the label devenv.config-path (LABEL_CONFIG_PATH)
   * of the dev service (review round 5, D5-1: not of the other services), when isConfigPathLabelValue takes it (D5-2).
   * Only the up model gets it.
   */
  configPath?: string;
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

/** A Go duration (`20s`, `1m30s`, `500ms`) in seconds; `undefined` when it is none. */
export function durationSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^(\d+(\.\d+)?(h|m|s|ms|us|µs|ns))+$/.test(value.trim())) return undefined;
  const factors: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, µs: 1e-6, ns: 1e-9 };
  let seconds = 0;
  for (const match of value.trim().matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)) seconds += Number(match[1]) * factors[match[2]];
  return seconds;
}

/** The model is our rewrite of a model that the check refused: the pipeline checks before it rewrites. */
function notChecked(item: string): Error {
  return new Error(`The Compose model has a setting that the host access policy refuses: ${item}`);
}

/**
 * `$` → `$$` in every text of a value (not in the keys): Compose then reads the texts as they are. Review round 20
 * (D20-1): Compose never interpolates a key, so the keys stay unescaped (COMPOSE_MODEL_SCRIPT unescapes them).
 */
export function escapeComposeDollars(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\$/g, '$$$$');
  if (Array.isArray(value)) return value.map(escapeComposeDollars);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, escapeComposeDollars(entry)]));
  return value;
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

/** Review round 10 (S10-1): `volumeNames` once per model (composeVolumeNames), not once per service. */
function mountContext(volumeNames: ReadonlyMap<string, string>, p: ComposeRewriteParams, isDev: boolean): ComposeMountContext {
  return {
    isDev,
    repositoryFolder: p.repositoryFolder,
    volumeNames,
    ownVolume: p.volumeName,
    engineApiVersion: p.engineApiVersion,
    realPaths: p.realPaths,
    mountAncestors: p.mountAncestors,
  };
}

/** The rewrites that the up model and the build model share. */
function rewriteModel(
  source: ComposeModel,
  p: ComposeRewriteParams,
): { model: ComposeModel; rewrites: ComposeRewrite[]; createFolders: string[]; serviceFolders: string[] } {
  const rewrites: ComposeRewrite[] = [];
  // Review round 9 (S9-1): Sets, so that many mounts cost linear time in the extension host.
  const createFolders = new Set<string>();
  const serviceFolders = new Set<string>();
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
  // Review round 10 (S10-1): once, not once per service (services x top-level volumes in the extension host).
  const volumeNames = new Map(composeVolumeNames(source, p.project).map((volume) => [volume.key, volume.name]));
  for (const [name, service] of Object.entries(model.services)) {
    if (!isRecord(service)) throw notChecked(`service ${name}`);
    const isDev = name === p.devService;
    const at = `service ${name}: `;
    // Labels: every container of the project carries the environment ID (Stop, the Session Monitor, Delete).
    const labels = labelMap(service.labels);
    labels[LABEL_ENVIRONMENT_ID] = p.environmentId;
    if (isDev) labels[LABEL_CONTAINER_VERSION] = String(CONTAINER_VERSION);
    else labels[LABEL_COMPOSE_SERVICE] = name;
    // Created while the host access checks were off: not current once they are on again (containerIsCurrent). Set on
    // every service either way (review round 2, D2-2), so that a label of an image that Compose builds or pulls during
    // `up` (not checked before) cannot make a container look unrestricted, or restricted.
    labels[LABEL_HOST_ACCESS] = checksOn ? HOST_ACCESS_CHECKED : HOST_ACCESS_UNRESTRICTED;
    // Review round 5: only on the dev service (D5-1: a label of the other services would change their configuration hash
    // with each switch of the selected configuration, and Compose would create them again), and only with a path that
    // reconcileFromVolumes takes (D5-2).
    if (isDev && p.configPath !== undefined && isConfigPathLabelValue(p.configPath)) labels[LABEL_CONFIG_PATH] = p.configPath;
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
    const ctx = mountContext(volumeNames, p, isDev);
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
      if (decision.action === 'replace' && decision.createFolder !== undefined) createFolders.add(decision.createFolder);
      // Review round 9 (D9-1): a path of the repository that another service mounts (from the workspace volume) may hold
      // the data of that service, with the owner that the service gives it: the ownership fix leaves it out. Review
      // round 10 (D10-3): not a read-only mount (the service writes nothing there, and a file that root rewrote, for
      // example at Switch branch…, must get its owner back), and never .git (serviceRepositoryPath). Review round 10
      // (D10-2): also the real path, when a link in the repository leads elsewhere in it (Docker follows the link of
      // the subpath), or where a created folder below a link lands.
      if (!isDev && decision.action === 'replace' && !(isRecord(decision.value) && decision.value.read_only === true)) {
        const folder = serviceRepositoryPath(decision.value, p.repositoryFolder);
        if (folder !== undefined) {
          serviceFolders.add(folder);
          const real = realServicePath(entry, p);
          if (real !== undefined && real !== folder && isServiceFolderPath(real, p.repositoryFolder)) serviceFolders.add(real);
        }
      }
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
    // Review round 7, P7-1: `always`/`unless-stopped` (the templates set it on the database) would start the container
    // together with Docker, outside the Session Monitor (D-14): rewritten to `no`, not refused (it gives no access).
    // Review round 8, S8-6: `on-failure[:n]` too: Docker starts such a container again when the Docker daemon starts.
    if (service.restart !== undefined && service.restart !== null && String(service.restart) !== 'no') {
      rewrites.push({ item: `${at}restart ${String(service.restart)}`, reason: 'Dev Environments starts the containers itself (no)' });
      service.restart = 'no';
    }
    // The same for `deploy.restart_policy`: a condition other than `none` (also a missing one, which is `any`, and,
    // review round 8, S8-6, `on-failure`) becomes `none`. Review round 8 (P8-1): without `max_attempts`, which Docker
    // Engine 25 and newer refuse with the restart policy `no` (Compose passes it as the count of retries).
    if (isRecord(service.deploy) && isRecord(service.deploy.restart_policy)) {
      const policy = service.deploy.restart_policy;
      const condition = policy.condition;
      if (condition !== 'none') {
        const text = condition === undefined || condition === null ? '(none given, any)' : String(condition);
        rewrites.push({ item: `${at}deploy.restart_policy.condition ${text}`, reason: 'Dev Environments starts the containers itself (none)' });
        policy.condition = 'none';
      }
      if (Object.prototype.hasOwnProperty.call(policy, 'max_attempts')) {
        if (policy.max_attempts !== undefined && policy.max_attempts !== null && policy.max_attempts !== 0) {
          rewrites.push({
            item: `${at}deploy.restart_policy.max_attempts ${String(policy.max_attempts)}`,
            reason: 'removed: Docker refuses a count of restarts with the restart policy none',
          });
        }
        delete policy.max_attempts;
      }
    }
    // Review round 8 (orchestrator decision): a stop_grace_period over MAX_STOP_TIMEOUT_SECONDS is capped, not refused:
    // the Session Monitor ends each Docker call after 30 s, also `docker stop`.
    const grace = service.stop_grace_period;
    if (grace !== undefined && grace !== null) {
      const seconds = durationSeconds(grace);
      if (seconds !== undefined && seconds > MAX_STOP_TIMEOUT_SECONDS) {
        const capped = `${MAX_STOP_TIMEOUT_SECONDS}s`;
        rewrites.push({ item: `${at}stop_grace_period ${String(grace)}`, reason: `the Session Monitor stops a container within 30 s (${capped})` });
        service.stop_grace_period = capped;
      }
    }
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
  return { model, rewrites, createFolders: [...createFolders], serviceFolders: [...serviceFolders] };
}

/**
 * Review round 9 (D9-1): the path in the helper (and in the dev container) of a mount of the workspace volume with a
 * subpath below the repository folder (decideServiceMount), for example `/workspaces/api/data/postgres`; `undefined` for
 * any other mount, and for the repository folder itself (a service that mounts the whole repository shares its source,
 * and leaving it out would leave every file of the repository to root).
 */
function serviceRepositoryPath(value: unknown, repositoryFolder: string): string | undefined {
  if (!isRecord(value) || value.source !== WORKSPACE_VOLUME_KEY || !isRecord(value.volume) || typeof value.volume.subpath !== 'string') return undefined;
  const folder = path.posix.join(WORKSPACES_ROOT, value.volume.subpath);
  return isServiceFolderPath(folder, repositoryFolder) ? folder : undefined;
}

/**
 * Review round 10: whether `folder` may be recorded as a path that another service mounts: below the repository folder
 * (never the folder itself), and (D10-3) never `.git` or a path in it, of the repository or of a nested repository
 * (Git writes there as root, for example at Switch branch…, and the files must get their owner back).
 */
function isServiceFolderPath(folder: string, repositoryFolder: string): boolean {
  if (folder === repositoryFolder || !folder.startsWith(`${repositoryFolder}/`)) return false;
  return !folder.slice(repositoryFolder.length + 1).split('/').includes('.git');
}

/**
 * Review round 10 (D10-2): where the bind mount source of `entry` is after links, in the helper (and in the dev
 * container): its real path (ComposeModelOutput.realPaths), or, for a folder that the pipeline creates, where it lands
 * (ComposeModelOutput.mountCreateTargets); `undefined` when neither is known.
 */
function realServicePath(entry: unknown, p: ComposeRewriteParams): string | undefined {
  if (!isRecord(entry) || typeof entry.source !== 'string') return undefined;
  const source = entry.source;
  const own = (map: Readonly<Record<string, string | null>> | undefined): string | null | undefined =>
    map !== undefined && Object.prototype.hasOwnProperty.call(map, source) ? map[source] : undefined;
  const real = own(p.realPaths);
  if (typeof real === 'string') return path.posix.normalize(real).replace(/(.)\/+$/, '$1');
  const created = own(p.mountCreateTargets);
  return typeof created === 'string' ? path.posix.normalize(created).replace(/(.)\/+$/, '$1') : undefined;
}

function portText(entry: unknown): string {
  if (!isRecord(entry)) return String(entry);
  const published = entry.published === undefined || entry.published === null ? '' : `${String(entry.published)}:`;
  return `${published}${String(entry.target)}${entry.protocol && entry.protocol !== 'tcp' ? `/${String(entry.protocol)}` : ''}`;
}

function mountText(entry: unknown): string {
  return isRecord(entry) ? `${String(entry.source)} → ${String(entry.target)}` : String(entry);
}

/**
 * Review round 19 (S19-1): the texts of the model are the unescaped ones (COMPOSE_MODEL_SCRIPT unescapes them when
 * `docker compose config` escapes them), so every text of a written model is escaped, whatever the Compose version.
 */
function finish(model: ComposeModel): ComposeModel {
  return escapeComposeDollars(model) as ComposeModel;
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
 *   bind mount there is dropped), the host name of the repository (containerHostname) unless the service decides
 *   it (serviceDecidesHostname), and (unit 15) the tmpfs of the token, TOKEN_TMPFS, added to its `tmpfs`;
 * - top-level `volumes`: each external, with its Docker name, plus the workspace volume (WORKSPACE_VOLUME_KEY) and the
 *   volumes of `mountVolumeSources`;
 * - the label devenv.host-access on every service: `checked`, or with the host access checks off (`hostAccessChecks`)
 *   `unrestricted` (review round 2, D2-2); with the checks off also the published ports as the model has them, and the
 *   mounts that only the class `computer` refuses unchanged;
 * - each text escaped (`$$`), whatever the Compose version (review round 19, S19-1: the model holds the unescaped texts).
 * `network_mode: service:<name>` stays as it is: the check allows only a service of the same model, which Compose
 * finds by its service name, not by the removed `container_name`. Throws when the model has a setting that the check
 * refuses (composeAccessReport must pass first). `rewrites` names each change for the log.
 */
export function composeUpModel(
  model: ComposeModel,
  p: ComposeRewriteParams & { image: string },
): ComposeModelRewrite & { createFolders?: string[]; serviceFolders?: string[] } {
  const { model: result, rewrites, createFolders, serviceFolders } = rewriteModel(model, p);
  const dev = result.services[p.devService];
  if (dev.build !== undefined && dev.build !== null) rewrites.push({ item: `service ${p.devService}: build`, reason: `the environment image ${p.image} is used` });
  delete dev.build;
  dev.image = p.image;
  // Without it, Docker names the host after the container ID, and the shell prompt shows that ID (as for a single
  // container, buildOverrideConfig). The other services keep theirs.
  if (!serviceDecidesHostname(dev)) dev.hostname = containerHostname(path.posix.basename(p.repositoryFolder));
  // Unit 15: the tmpfs of the token (TOKEN_FOLDER), only in the dev container. The check refused every entry of the
  // repository there (configFolderTarget), so this one is the only one.
  dev.tmpfs = [...tmpfsEntries(dev.tmpfs), TOKEN_TMPFS];
  // Review round 8 (P8-2): the folders of the repository that the pipeline creates before `up`.
  // Review round 9 (D9-1): the paths of the repository that the other services mount (serviceRepositoryPath).
  return {
    model: finish(result),
    rewrites,
    ...(createFolders.length > 0 ? { createFolders } : {}),
    ...(serviceFolders.length > 0 ? { serviceFolders } : {}),
  };
}

/** The entries of `tmpfs` of a service of the model (a text, a list, or none). */
function tmpfsEntries(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? [...value] : [value];
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
 *   CLI reads the Dockerfile itself and knows only `build.dockerfile`: function `lp`, `dockerfilePath:r.dockerfile??"Dockerfile"`).
 *   Review round 20 (P20-1): a Dockerfile file too: its checked text (`p.dockerfiles`) is written to
 *   COMPOSE_DEV_DOCKERFILE. The CLI reads the path from the output of `docker compose config` of this model, which an escaping Compose prints
 *   with `$$`, while BuildKit reads the unescaped one: with a `$` in the path or the context, they would read two
 *   different files; and the file could change between the check and the build. Throws when the model run read no text
 *   for it (fail closed);
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
      devDockerfile = dev.build.dockerfile_inline;
      delete dev.build.dockerfile_inline;
    } else {
      // Review round 20 (P20-1): the checked text, never the path.
      const own = <T>(map: Readonly<Record<string, T>> | undefined): T | undefined =>
        map !== undefined && Object.prototype.hasOwnProperty.call(map, p.devService) ? map[p.devService] : undefined;
      const text = own(p.dockerfiles);
      if (typeof text !== 'string') throw notChecked(`service ${p.devService}: build (its Dockerfile was not read)`);
      devDockerfile = text;
    }
    dev.build.dockerfile = COMPOSE_DEV_DOCKERFILE;
  } else if (typeof dev.image === 'string' && dev.image.trim() !== '') {
    devDockerfile = `FROM ${dev.image.trim()}\n`;
    dev.build = { context: COMPOSE_BUILD_CONTEXT, dockerfile: COMPOSE_DEV_DOCKERFILE };
  } else {
    throw notChecked(`service ${p.devService}: no image and no build`);
  }
  dev.image = image;
  const escaped = finish(result);
  return { model: escaped, rewrites, ...(devDockerfile !== undefined ? { devDockerfile } : {}) };
}
