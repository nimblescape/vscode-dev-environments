// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3 (section 0 of the plan, no duplicates): the Docker objects as the pipeline knows them, and the one
// reading of their inspect JSON. `docker inspect` and the Engine API (`GET /containers/<id>/json`, `/volumes/<name>`,
// `/networks/<id>`) answer with the same JSON, so the worker's adapter over the port (src/core/worker/engineDocker.ts)
// and the engine client of the helper channel read it with the same functions (plan step 11I2: the CLI adapter that read
// `docker inspect` with them, ContainerAdapter, is removed). Pure; no I/O.
import * as path from 'path';
import type { ContainerState } from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ContainerInfo {
  id: string;
  /** Without the leading '/'. */
  name: string;
  state: ContainerState;
  /** `State.Status` of `docker inspect`, for example `exited`. */
  rawState: string;
  labels: Record<string, string>;
  /** Image reference that the container was created from (`Config.Image`), for example `devenv-acme-api-brave-noether:2`. */
  image: string;
  /**
   * Review round 1 of PR #88 (A-R1-1): the full ID of the image that the container was created from (`Image` of `docker
   * inspect`); `image` is only a name, which may name another image by now.
   */
  imageId?: string;
  /** Names of the named volumes that the container mounts (`Mounts` with `Type` volume). */
  volumes?: string[];
  /**
   * Review round 11 (G3, G4): the subpaths of named volumes that the container mounts (`HostConfig.Mounts`, and
   * `Mounts`, with `Type` volume and `VolumeOptions.Subpath`), as Docker Compose creates them for a bind mount of
   * repository files that the pipeline rewrote to the workspace volume.
   */
  volumeSubpaths?: VolumeSubpathMount[];
  /**
   * Review round 12 (D12-2): the targets of the mounts of the container in it (`Mounts`: volumes, bind mounts, tmpfs;
   * and the tmpfs of `HostConfig.Tmpfs`), for the ownership fix in the dev container (devMountFolders).
   */
  mountTargets?: MountTarget[];
}

/** Review round 12 (D12-2): a mount of a container (ContainerInfo.mountTargets). */
export interface MountTarget {
  /** `volume`, `bind`, `tmpfs`, … */
  type: string;
  /** The name of a named volume. */
  volume?: string;
  /** The path in the container (`Destination`). */
  target: string;
  /**
   * Review round 14 (P14-1): the subpath of a named volume (`VolumeOptions.Subpath` of the entry of `HostConfig.Mounts`
   * with the same volume and target; the top-level `Mounts` do not have it). Missing: the whole volume, or not known.
   */
  subpath?: string;
  /** Plan step 11H1: the mount is read-only (`RW` false); missing: read-write, or not known. */
  readOnly?: true;
}

/** Review round 11 (G3, G4): a mount of a subpath of a named volume (ContainerInfo.volumeSubpaths). */
export interface VolumeSubpathMount {
  volume: string;
  /** Relative to the root of the volume, as Docker has it (for example `api/data/postgres`). */
  subpath: string;
  readOnly: boolean;
}

export interface VolumeInfo {
  name: string;
  labels: Record<string, string>;
}

/** A network of `docker network inspect`. */
export interface NetworkInfo {
  name: string;
  /** The full ID of the network (review round 2, S2-04: a configuration may name a network by its ID or a prefix). */
  id: string;
  labels: Record<string, string>;
  /** The IDs of the containers attached to it. */
  containers: string[];
}

/** A local image of `docker image ls`. */
export interface ImageInfo {
  /** Full image ID, for example `sha256:7a83…`. */
  id: string;
  /** References `repository:tag`; empty for a dangling image. */
  tags: string[];
  /** Creation time as Docker prints it, for example `2026-09-25 02:31:55 +0200 CEST`. */
  createdAt: string;
}

/**
 * Review round 9 (S9-3): an image as `docker image inspect` describes it: its ID, tags, and digests. Plan step 11I2: moved
 * here from containerAdapter.ts, which is removed.
 */
export interface ImageNames {
  id: string;
  repoTags: string[];
  repoDigests: string[];
}

/**
 * Review round 11 (G1): why inspectImageNames could not check a reference. `invalid`: Docker's answer is about the
 * reference itself (an invalid reference, or an image ID prefix that matches more than one image), the same at every
 * call. `transient`: the answer says nothing about the reference (a timeout, a daemon that cannot be reached or fails, an
 * unknown error, or a reference after the first such failure).
 */
export type ImageUncheckedReason = 'invalid' | 'transient';

/** The result of inspectImageNames (review round 10, P10-1). */
export interface ImageInspection {
  /** The local images that the references found. */
  images: ImageNames[];
  /** The references that Docker could not inspect for another reason than a missing image, each with its reason. */
  unchecked: Array<{ reference: string; reason: ImageUncheckedReason }>;
}

/**
 * Maps `State.Status` to the simplified state: running|restarting|paused → 'running';
 * created|exited|dead|removing (and unknown values) → 'stopped'.
 */
export function mapContainerState(rawState: string): ContainerState {
  switch (rawState.toLowerCase()) {
    case 'running':
    case 'restarting':
    case 'paused':
      return 'running';
    default:
      return 'stopped';
  }
}

/** Labels object of `docker inspect` (may be `null`). Values that are not strings are ignored. */
export function toLabels(value: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!isRecord(value)) return labels;
  for (const [key, labelValue] of Object.entries(value)) {
    if (typeof labelValue === 'string') labels[key] = labelValue;
  }
  return labels;
}

export interface InspectedContainer extends ContainerInfo {
  created: string;
}

/**
 * Plan step 11I (U4, decision of 2026-10-08): a container of the lists of the pipeline's Docker (EnvironmentDocker), with
 * the time of its create, by which the rule of the dev container (devContainerOf, src/core/worker/environmentContainers.ts)
 * takes the newest one.
 */
export interface ListedContainer extends ContainerInfo {
  /** When the daemon created it (`Created` of the inspect, RFC 3339); absent when it is not known. */
  created?: string;
}

export function toContainerInfo(value: unknown): InspectedContainer | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.Id;
  const name = value.Name;
  const state = value.State;
  const config = value.Config;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !isRecord(state) || typeof state.Status !== 'string') {
    return undefined;
  }
  const image = isRecord(config) && typeof config.Image === 'string' ? config.Image : '';
  return {
    id,
    name: name.replace(/^\//, ''),
    state: mapContainerState(state.Status),
    rawState: state.Status,
    labels: toLabels(isRecord(config) ? config.Labels : undefined),
    image,
    ...(typeof value.Image === 'string' && value.Image !== '' ? { imageId: value.Image } : {}),
    volumes: mountedVolumes(value.Mounts),
    volumeSubpaths: volumeSubpathMounts([
      ...(Array.isArray(value.Mounts) ? value.Mounts : []),
      ...(isRecord(value.HostConfig) && Array.isArray(value.HostConfig.Mounts) ? value.HostConfig.Mounts : []),
    ]),
    mountTargets: mountTargets(
      value.Mounts,
      isRecord(value.HostConfig) ? value.HostConfig.Tmpfs : undefined,
      isRecord(value.HostConfig) ? value.HostConfig.Mounts : undefined,
    ),
    created: typeof value.Created === 'string' ? value.Created : '',
  };
}

/** A target path as Docker compares it: normalized, without a trailing slash. */
function cleanTarget(target: string): string {
  const normal = path.posix.normalize(target);
  return normal.length > 1 ? normal.replace(/\/+$/, '') : normal;
}

/**
 * Review round 12 (D12-2): the mounts of `docker container inspect` with their targets (ContainerInfo.mountTargets).
 * Review round 14 (P14-1): a volume mount with the subpath of the entry of `HostConfig.Mounts` (`hostMounts`) with the
 * same volume (`Source`) and target; with more than one such entry of different subpaths, none (not known).
 */
function mountTargets(mounts: unknown, tmpfs: unknown, hostMounts: unknown): MountTarget[] {
  const subpaths = new Map<string, string | null>();
  for (const mount of Array.isArray(hostMounts) ? hostMounts : []) {
    if (!isRecord(mount) || mount.Type !== 'volume' || typeof mount.Target !== 'string' || !mount.Target.startsWith('/')) continue;
    if (typeof mount.Source !== 'string' || mount.Source === '' || !isRecord(mount.VolumeOptions)) continue;
    const subpath = mount.VolumeOptions.Subpath;
    if (typeof subpath !== 'string' || subpath === '') continue;
    const key = `${mount.Source}\0${cleanTarget(mount.Target)}`;
    subpaths.set(key, subpaths.has(key) && subpaths.get(key) !== subpath ? null : subpath);
  }
  const result: MountTarget[] = [];
  for (const mount of Array.isArray(mounts) ? mounts : []) {
    if (!isRecord(mount) || typeof mount.Destination !== 'string' || mount.Destination === '' || typeof mount.Type !== 'string') continue;
    const volume = mount.Type === 'volume' && typeof mount.Name === 'string' && mount.Name !== '' ? mount.Name : undefined;
    const subpath = volume !== undefined && mount.Destination.startsWith('/') ? subpaths.get(`${volume}\0${cleanTarget(mount.Destination)}`) : undefined;
    result.push({
      type: mount.Type,
      ...(volume !== undefined ? { volume } : {}),
      target: mount.Destination,
      ...(typeof subpath === 'string' ? { subpath } : {}),
      // Plan step 11H1: the link of the shared VS Code server needs the store read-only.
      ...(mount.RW === false ? { readOnly: true as const } : {}),
    });
  }
  if (isRecord(tmpfs)) for (const target of Object.keys(tmpfs)) if (target !== '') result.push({ type: 'tmpfs', target });
  return result;
}

function mountedVolumes(mounts: unknown): string[] {
  if (!Array.isArray(mounts)) return [];
  return mounts
    .filter((mount): mount is Record<string, unknown> => isRecord(mount) && mount.Type === 'volume' && typeof mount.Name === 'string' && mount.Name !== '')
    .map((mount) => mount.Name as string);
}

/**
 * Review round 11 (G3, G4): the volume mounts with a subpath of `docker container inspect` (`HostConfig.Mounts` has
 * `Source`, the name of the volume; `Mounts` has `Name`), without duplicates.
 */
function volumeSubpathMounts(mounts: readonly unknown[]): VolumeSubpathMount[] {
  const result = new Map<string, VolumeSubpathMount>();
  for (const mount of mounts) {
    if (!isRecord(mount) || mount.Type !== 'volume' || !isRecord(mount.VolumeOptions)) continue;
    const subpath = mount.VolumeOptions.Subpath;
    const volume = typeof mount.Name === 'string' && mount.Name !== '' ? mount.Name : mount.Source;
    if (typeof subpath !== 'string' || subpath === '' || typeof volume !== 'string' || volume === '') continue;
    const readOnly = mount.ReadOnly === true || mount.RW === false;
    const key = `${volume}\0${subpath}\0${readOnly}`;
    if (!result.has(key)) result.set(key, { volume, subpath, readOnly });
  }
  return [...result.values()];
}

export function toVolumeInfo(value: unknown): VolumeInfo | undefined {
  if (!isRecord(value) || typeof value.Name !== 'string' || !value.Name) return undefined;
  return { name: value.Name, labels: toLabels(value.Labels) };
}

export function toNetworkInfo(value: unknown): NetworkInfo | undefined {
  if (!isRecord(value) || typeof value.Name !== 'string' || !value.Name) return undefined;
  const containers = isRecord(value.Containers) ? Object.keys(value.Containers) : [];
  return { name: value.Name, id: typeof value.Id === 'string' ? value.Id : '', labels: toLabels(value.Labels), containers };
}

export function publicInfo(container: InspectedContainer): ContainerInfo {
  const { id, name, state, rawState, labels, image, imageId, volumes, volumeSubpaths, mountTargets } = container;
  return {
    id,
    name,
    state,
    rawState,
    labels,
    image,
    // Review round 2 of PR #88 (B-R2-1): the ID of the container's image (containerImage, A-R1-1).
    ...(imageId !== undefined ? { imageId } : {}),
    ...(volumes && volumes.length > 0 ? { volumes } : {}),
    ...(volumeSubpaths && volumeSubpaths.length > 0 ? { volumeSubpaths } : {}),
    ...(mountTargets && mountTargets.length > 0 ? { mountTargets } : {}),
  };
}

// Plan step 11I (U4, decision of 2026-10-08): `preferred` (a running container first, then the newest by the text of its
// time) is removed; the one rule of the dev container is devContainerOf (src/core/worker/environmentContainers.ts).
