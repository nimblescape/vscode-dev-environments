// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The merged model of a Docker Compose configuration and the names in it: the types, the key of the workspace volume,
// the versions of Compose and of the Docker Engine, and the Docker names of the top-level volumes and networks. Split off
// ./compose.ts in unit 11, so that the container policy (../policy) can use them without an import cycle (./compose.ts
// builds the models that run and calls the policy). Pure functions, no I/O.
import { isRecord } from '../valueChecks';

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

/** Key of the workspace volume in the top-level `volumes` of our model. The check refuses it in a repository. */
export const WORKSPACE_VOLUME_KEY = 'devenv-workspace';

/**
 * Plan step 11H1: key of the shared VS Code server store (VSCODE_STORE_VOLUME, or the store of the worker) in the
 * top-level `volumes` of our up model. The check refuses it in a repository.
 */
export const VSCODE_STORE_KEY = 'devenv-vscode';

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

/** A Go duration (`20s`, `1m30s`, `500ms`) in seconds; `undefined` when it is none. */
export function durationSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^(\d+(\.\d+)?(h|m|s|ms|us|µs|ns))+$/.test(value.trim())) return undefined;
  const factors: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, µs: 1e-6, ns: 1e-9 };
  let seconds = 0;
  for (const match of value.trim().matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)) seconds += Number(match[1]) * factors[match[2]];
  return seconds;
}
