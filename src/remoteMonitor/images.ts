// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The images of the Session Monitor on a remote Docker host (user requests 2026-09-28: "the monitor tasks shall look for
// all devcontainer-dev* and devcontainer-classroom* images and shall regularly pull these images as when new updates are
// available … always the latest major version image"; "the monitor shall only keep the two latest versions of these
// images and clean the images from docker regularly"; "only in the remote scenario"; "1 minute after the monitor starts
// then in the morning again, at 6:07 CEST"; "a setting that tells the monitor to fetch in a guided cron style manner"). A
// pass one minute after the start of the monitor, then at each time of the cron schedule of the setting
// imageUpdateSchedule (default `7 6 * * *`: 06:07) in the time zone of the computer that created the monitor (plan step
// 11H2, decision of 2026-10-09: part a of the monitor's background run, background.ts, by the schedule of the setting
// cacheUpdateSchedule, which replaces imageUpdateSchedule; D5: the setting imageUpdates names the images):
//   1. The repositories whose name starts with one of the prefixes (the setting imageUpdates): those on the engine,
//      and those of the list that the extension sent ("all images": the registry lists no repositories without a token,
//      so the extension reads the packages with its GitHub session and sends only the names; `monitor.js images -`).
//   2. For each: the tags of the registry (anonymous, the token of its challenge); the highest major tag (a plain number,
//      for example `2`) is pulled (`<repository>:<major>`: the engine downloads only what changed).
//   3. For each: the two newest versions stay (an image ID is one version: its highest version tag, a shorter tag such as
//      `2` or `latest` above the longer ones of its line, else its creation time); every older one is removed when no
//      container uses it and no other image is built on it (an environment image: its layers start with those of the
//      older one), without force.
// Plan step 11I (U1, decision of 2026-10-08): every request to the engine goes over the Engine API (the port of
// engine.ts; before, the Docker CLI of the container), each within its time limit; the pull without a login, as the CLI
// of the monitor had none. Never throws; each problem is one line of the log.
import type { IncomingMessage } from 'http';
import * as https from 'https';
import { imagePrefixesOf } from '../core/remoteMonitor/protocol';
import type { EngineImage } from '../core/worker/dockerEngine';
import { engineFailure, type ImageEngine } from './engine';

/** Time from the start of the monitor to the first pass. */
export const REMOTE_IMAGE_FIRST_PASS_MS = 60_000;
/** The number of versions of a repository that stay. */
export const KEPT_IMAGE_VERSIONS = 2;
/**
 * Time limits. Plan step 11I (U1): of each request of a list or an inspect (IMAGE_LIST_TIMEOUT_MS), of a pull, and of the
 * removal of one version (all of its references).
 */
export const IMAGE_LIST_TIMEOUT_MS = 60_000;
export const IMAGE_PULL_TIMEOUT_MS = 60 * 60_000;
export const IMAGE_REMOVE_TIMEOUT_MS = 120_000;
export const REGISTRY_TIMEOUT_MS = 30_000;
/** The longest answer of a registry that is read. */
const MAX_REGISTRY_BODY = 4 * 1024 * 1024;
/** At most this many pages of a tag list. */
const MAX_TAG_PAGES = 20;

/** An HTTP GET: status, lower-case headers, body. Rejects on a network error or the time limit. */
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

/**
 * HttpGet with https. Review round 2 of PR #57 (R5): settles in every case within REGISTRY_TIMEOUT_MS: the idle time
 * limit of the socket alone let a registry that sends a byte now and then, or a connection cut in the middle of the
 * answer (no `end`, no error of the request), keep a pass open for ever, and with it every later pass.
 */
export const nodeHttpGet: HttpGet = (url, headers) => httpGetWith(https.get, url, headers, REGISTRY_TIMEOUT_MS);

/** nodeHttpGet with another `get` (the tests: `http.get` of a local server) and time limit. */
export function httpGetWith(
  get: typeof https.get,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): ReturnType<HttpGet> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Review round 3 of PR #57 (N1): `get` throws at once for an invalid URL (the realm of a registry's challenge) or
    // header (its token); then there is no request, and the time limit found none to end (an uncaught error ended the
    // monitor).
    let request: ReturnType<typeof https.get> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request?.destroy();
      reject(error);
    };
    const onResponse = (response: IncomingMessage) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_REGISTRY_BODY) fail(new Error('The answer of the registry is too large.'));
      });
      response.on('error', (error) => fail(error));
      response.on('close', () => {
        if (!response.complete) fail(new Error('The connection to the registry was cut.'));
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        const flat: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) flat[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        resolve({ status: response.statusCode ?? 0, headers: flat, body });
      });
    };
    const deadline = setTimeout(() => fail(new Error('The registry did not answer in time.')), timeoutMs);
    try {
      request = get(url, { headers, timeout: timeoutMs }, onResponse);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.on('timeout', () => fail(new Error('The registry did not answer in time.')));
    request.on('error', (error) => fail(error));
  });
}

/** One image of a repository, as one row of `docker image ls` showed it. */
export interface LocalImage {
  repository: string;
  /** `<none>` for an image of the repository without a tag of it. */
  tag: string;
  id: string;
  /** Creation time (RFC 3339: the list of the engine, or the inspect of an image); compared as a time (createdTime). */
  createdAt: string;
}

/** A tag as the Docker reference grammar allows it. */
const TAG = /^[\w][\w.-]{0,127}$/;

/**
 * Plan step 11I (U1, decision of 2026-10-08): the rows of `docker image ls -a` (the Docker CLI's formatter), from the
 * images of the list of the engine: a row per repository and tag of an image (its `repository:tag` references), and a
 * row with the tag `<none>` per repository of which it has only a digest (`repository@sha256:…`, an image that a pull
 * replaced on the classic image store). An image without any reference (a `<none> <none>` row, of no prefix) has none.
 * The list without `all`: the engine then leaves out only intermediate images without a reference (the parents of the
 * classic builder's images), which have no row of a repository either.
 */
export function localImagesOf(images: readonly EngineImage[]): LocalImage[] {
  const rows: LocalImage[] = [];
  for (const image of images) {
    const tagged = new Set<string>();
    for (const reference of image.repoTags) {
      const colon = reference.lastIndexOf(':');
      // Only `repository:tag` (the colon of a registry port comes before the last slash).
      if (colon <= reference.lastIndexOf('/') || !TAG.test(reference.slice(colon + 1))) continue;
      const repository = reference.slice(0, colon);
      tagged.add(repository);
      rows.push({ repository, tag: reference.slice(colon + 1), id: image.id, createdAt: image.created });
    }
    const digestOnly = new Set<string>();
    for (const reference of image.repoDigests) {
      const at = reference.indexOf('@');
      if (at <= 0) continue;
      const repository = reference.slice(0, at);
      if (tagged.has(repository) || digestOnly.has(repository)) continue;
      digestOnly.add(repository);
      rows.push({ repository, tag: '<none>', id: image.id, createdAt: image.created });
    }
  }
  return rows;
}

/** The highest major tag of a tag list (a plain number: `2`, `10`), or undefined. */
export function highestMajorTag(tags: readonly string[]): string | undefined {
  let best: number | undefined;
  for (const tag of tags) {
    if (!/^(0|[1-9][0-9]{0,5})$/.test(tag)) continue;
    const major = Number(tag);
    if (best === undefined || major > best) best = major;
  }
  return best === undefined ? undefined : String(best);
}

/**
 * A version tag as numbers (`2.0.14` → [2, 0, 14]); undefined for any other tag (`latest`, `2.0.14-amd64`). Review round
 * 2 of PR #57 (R4): `latest` is no version: the monitor never pulls it, so a `latest` on the engine can be of any age.
 */
function versionOf(tag: string): number[] | undefined {
  return /^[0-9]{1,6}(\.[0-9]{1,6}){0,3}$/.test(tag) ? tag.split('.').map(Number) : undefined;
}

/**
 * Review round 1 of PR #57 (A): a shorter version tag names the newest image of its line (`2` the newest 2.x.y, `2.0`
 * the newest 2.0.y), so a missing part is above every number: `2` > `2.0` > `2.0.14` > `2.0.13`, and `2` < `3.0.0`. Before, a missing part counted as -1, so the image just pulled as `:2` could rank below older
 * `2.0.x` images and be removed.
 */
function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? Infinity;
    const y = b[index] ?? Infinity;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** One version of a repository: an image ID with its tags there. */
export interface ImageVersion {
  id: string;
  tags: string[];
  createdAt: string;
  /** The highest version tag of the ID, if it has one. */
  version?: number[];
}

/**
 * The versions of one repository, newest first: an ID with a version tag is newer than one without (an ID without a tag
 * of the repository was replaced); between two with one, the higher version; else the later creation time.
 */
export function versionsOf(images: readonly LocalImage[]): ImageVersion[] {
  const byId = new Map<string, ImageVersion>();
  for (const image of images) {
    const entry = byId.get(image.id) ?? { id: image.id, tags: [], createdAt: image.createdAt };
    byId.set(image.id, entry);
    if (image.tag !== '<none>' && !entry.tags.includes(image.tag)) entry.tags.push(image.tag);
    const version = versionOf(image.tag);
    if (version && (!entry.version || compareVersions(version, entry.version) > 0)) entry.version = version;
  }
  return [...byId.values()].sort((a, b) => {
    if (a.version && b.version) {
      const difference = compareVersions(b.version, a.version);
      if (difference !== 0) return difference;
    } else if (a.version || b.version) {
      return a.version ? -1 : 1;
    }
    // Review round 6 of PR #57 (F1): as times, as `docker image ls` and `docker image inspect` write them differently.
    return createdTime(b.createdAt) - createdTime(a.createdAt);
  });
}

/** `registry` and `path` of a repository (`ghcr.io/majikmate/devcontainer-dev`); undefined without a registry. */
export function splitRepository(repository: string): { registry: string; path: string } | undefined {
  const slash = repository.indexOf('/');
  if (slash <= 0) return undefined;
  const registry = repository.slice(0, slash);
  if (!/[.:]/.test(registry) && registry !== 'localhost') return undefined;
  return { registry, path: repository.slice(slash + 1) };
}

/** The Bearer challenge of `WWW-Authenticate`: realm, service, scope. */
export function parseBearerChallenge(header: string | undefined): { realm: string; service?: string; scope?: string } | undefined {
  if (!header || !/^Bearer\s/i.test(header)) return undefined;
  const fields: Record<string, string> = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) fields[match[1].toLowerCase()] = match[2];
  if (!fields.realm || !/^https:\/\//.test(fields.realm)) return undefined;
  return { realm: fields.realm, service: fields.service, scope: fields.scope };
}

export interface ImageMaintenanceDeps {
  /** Plan step 11I (U1, decision of 2026-10-08): the engine over the Engine API (engine.ts), not the Docker CLI. */
  engine: ImageEngine;
  httpGet: HttpGet;
  log: (message: string) => void;
  /**
   * The prefixes of the pass: those of the container (DEVENV_IMAGE_PREFIXES), or the newer ones that an extension sent
   * (`monitor.js settings -`; review round 1 of PR #57, C: the settings are not part of the label anymore).
   */
  prefixes: () => readonly string[];
  /** The repositories of the list that the extension sent (none when it sent none). */
  knownRepositories: () => Promise<string[]>;
  /**
   * Review round 6 of PR #57 (F1): the IDs that were seen as images of a repository, by repository, kept in the volume.
   * The image that a pull replaces loses its tag, and the list of the images shows it without its repository (the
   * containerd image store; `docker image ls` of the CLI 29 showed it not at all without `-a`), so without these IDs no
   * older version would ever be removed. Review round 7: every ID that a pass sees with a tag of the repository, not only
   * those that the monitor's own pull replaced (the update of the extension at each open, or a user, pulls too). Without
   * it: kept for the pass.
   */
  replaced?: { read(): Promise<ReplacedImages>; write(value: ReplacedImages): Promise<void> };
}

/** Image IDs that a pull replaced, by repository. */
export type ReplacedImages = Record<string, string[]>;

/** Plan step 11I (U1): the fields of the inspect JSON of an image (as `docker image inspect`) that the maintenance reads. */
interface InspectedImage {
  Id?: unknown;
  RepoTags?: unknown;
  Created?: unknown;
  RootFS?: { Layers?: unknown } | null;
}
/**
 * At most this many IDs are kept per repository. Review round 8 of PR #57 (S2): 200 (was 20), and beyond it the IDs that
 * are tagged now go first (the listing finds them again), then the oldest untagged ones (trimReplaced).
 */
const MAX_REPLACED_PER_REPOSITORY = 200;

/** Trims the IDs of a repository to MAX_REPLACED_PER_REPOSITORY: tagged ones first, then the oldest. */
function trimReplaced(ids: string[], tagged: ReadonlySet<string>): string[] {
  const result = [...ids];
  while (result.length > MAX_REPLACED_PER_REPOSITORY) {
    const index = result.findIndex((id) => tagged.has(id));
    result.splice(index >= 0 ? index : 0, 1);
  }
  return result;
}
const IMAGE_ID = /^[A-Za-z0-9:]{1,100}$/;

/** The stored replaced IDs; an empty record for anything invalid. */
export function parseReplacedImages(text: string): ReplacedImages {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const result: ReplacedImages = {};
    for (const [repository, ids] of Object.entries(value)) {
      if (splitRepository(repository) && Array.isArray(ids)) result[repository] = ids.filter((id): id is string => typeof id === 'string' && IMAGE_ID.test(id)).slice(-MAX_REPLACED_PER_REPOSITORY);
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Monitor cleanup, user decision 2026-09-29 (R3): the stored IDs without the repositories that keep none. A new record; the
 * given one is not changed. Review round 1 of PR #63 (B1): the repositories of no current prefix stay: the prefixes are
 * those of the computer that opened last, so on a shared engine they change between computers, and the replaced images
 * of the others would be left on the disk for ever.
 */
export function pruneReplacedImages(replaced: ReplacedImages): ReplacedImages {
  const result: ReplacedImages = {};
  for (const [repository, ids] of Object.entries(replaced)) {
    if (ids.length > 0) result[repository] = ids;
  }
  return result;
}

/**
 * The time of a LocalImage (ms; 0 when unknown): RFC 3339 of the list or of the inspect of the engine (plan step 11I,
 * U1), or the form of `CreatedAt` that `docker image ls` printed before.
 */
function createdTime(text: string): number {
  return Date.parse(text.replace(/ ([+-]\d{4}) [A-Z]+$/, ' $1')) || 0;
}

/** The passes of the image maintenance. */
export class ImageMaintenance {
  private replaced: ReplacedImages = {};

  constructor(private readonly deps: ImageMaintenanceDeps) {}

  /** One pass: the pulls, then the removal of the older versions. Never throws. */
  async pass(): Promise<void> {
    const prefixes = this.deps.prefixes();
    if (prefixes.length === 0) return;
    try {
      if (this.deps.replaced) this.replaced = await this.deps.replaced.read();
      const local = await this.repositories(prefixes);
      await this.remember(local);
      const known = (await this.deps.knownRepositories()).filter((repository) => prefixes.some((prefix) => repository.startsWith(prefix)));
      for (const repository of new Set([...local.keys(), ...known])) await this.update(repository);
      const after = await this.repositories(prefixes);
      await this.remember(after);
      for (const repository of Object.keys(this.replaced)) {
        if (!after.has(repository) && prefixes.some((prefix) => repository.startsWith(prefix))) after.set(repository, []);
      }
      const layers = after.size > 0 ? await this.layersById() : new Map<string, string[]>();
      // Review round 8 of PR #57 (S1): an ID can be a version of two repositories; one that one of them keeps is removed
      // by none of them.
      const all = new Map<string, LocalImage[]>();
      for (const [repository, images] of after) all.set(repository, [...images, ...(await this.replacedImages(repository, images))]);
      const kept = new Set<string>();
      for (const images of all.values()) for (const version of this.versions(images).slice(0, KEPT_IMAGE_VERSIONS)) kept.add(version.id);
      for (const [repository, images] of all) await this.clean(repository, images, layers, kept);
    } catch (error) {
      this.deps.log(`The images could not be maintained: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Monitor cleanup, user decision 2026-09-29 (R3): no empty lists (review round 1 of PR #63, B1: the repositories of
      // other prefixes stay).
      this.replaced = pruneReplacedImages(this.replaced);
      await this.deps.replaced?.write(this.replaced).catch(() => undefined);
    }
  }

  /**
   * Review round 7 of PR #57: keeps the IDs that carry a tag of a repository now, and writes the store at once (a monitor
   * that ends in the middle of a pass loses nothing).
   */
  async remember(images: ReadonlyMap<string, readonly LocalImage[]>): Promise<void> {
    let changed = false;
    for (const [repository, list] of images) {
      const tagged = new Set(list.filter((image) => image.tag !== '<none>').map((image) => image.id));
      for (const id of tagged) {
        if ((this.replaced[repository] ?? []).includes(id)) continue;
        this.replaced[repository] = [...(this.replaced[repository] ?? []), id];
        changed = true;
      }
      this.replaced[repository] = trimReplaced(this.replaced[repository] ?? [], tagged);
    }
    if (changed) await this.deps.replaced?.write(this.replaced).catch(() => undefined);
  }

  /**
   * Review round 8 of PR #57 (S3): remembers the IDs that carry a tag of a repository now, between the passes too (the
   * schedule calls it every minute; one list of the images), so an image that the extension pulls at an open and
   * replaces at the next one before a pass is known. Never throws.
   */
  async observe(): Promise<void> {
    const prefixes = this.deps.prefixes();
    if (prefixes.length === 0) return;
    try {
      if (this.deps.replaced) this.replaced = await this.deps.replaced.read();
      await this.remember(await this.repositories(prefixes));
    } catch {
      // The next minute or pass tries again.
    }
  }

  /**
   * Plan step 11I (U1, decision of 2026-10-08): the inspect JSON of an image (as `docker image inspect`), within the time
   * limit of a list; undefined when it does not exist or cannot be read (the engine does not answer), as a failed
   * `docker image inspect` was.
   */
  private async inspectImage(reference: string): Promise<InspectedImage | undefined> {
    try {
      return (await this.deps.engine.inspect('image', reference, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS))) as InspectedImage | undefined;
    } catch {
      return undefined;
    }
  }

  /** The ID of an image reference, or undefined. */
  private async imageId(reference: string): Promise<string | undefined> {
    const id = (await this.inspectImage(reference))?.Id;
    return typeof id === 'string' && IMAGE_ID.test(id) ? id : undefined;
  }

  /**
   * Review round 6 of PR #57 (F1): the stored replaced IDs of `repository` that still exist without any tag, as
   * untagged images of it; the others are forgotten (removed, or tagged again). Plan step 11I (U1): an image whose
   * inspect fails is forgotten too, as one of a failed `docker image inspect` was.
   */
  private async replacedImages(repository: string, listed: readonly LocalImage[]): Promise<LocalImage[]> {
    const ids = (this.replaced[repository] ?? []).filter((id) => !listed.some((image) => image.id === id));
    const result: LocalImage[] = [];
    const kept: string[] = [];
    for (const id of ids) {
      const inspected = await this.inspectImage(id);
      // Untagged: RepoTags `[]` or null (as `{{json .RepoTags}}` printed them); a time of its creation as text.
      const tags = inspected?.RepoTags;
      const created = inspected?.Created;
      if (typeof created !== 'string' || !(tags === null || (Array.isArray(tags) && tags.length === 0))) continue;
      kept.push(id);
      result.push({ repository, tag: '<none>', id, createdAt: created });
    }
    // Review round 8 of PR #57 (S2): in the order they were seen (the oldest first), so the trim keeps the newest.
    this.replaced[repository] = (this.replaced[repository] ?? []).filter((id) => kept.includes(id) || listed.some((image) => image.id === id));
    return result;
  }

  /** The images of the repositories with one of the prefixes, by repository. */
  private async repositories(prefixes: readonly string[]): Promise<Map<string, LocalImage[]>> {
    // Review round 7 of PR #57: `-a`, as the Docker CLI 29 shows untagged images (`<repository> <none>`) only with it.
    // Plan step 11I (U1, decision of 2026-10-08): the list of the engine has them (the CLI hid them), as rows of
    // `docker image ls -a` (localImagesOf).
    let listed: EngineImage[];
    try {
      listed = await this.deps.engine.images({}, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS));
    } catch (error) {
      throw new Error(`the list of the images failed: ${engineFailure(error, IMAGE_LIST_TIMEOUT_MS)}`);
    }
    const byRepository = new Map<string, LocalImage[]>();
    for (const image of localImagesOf(listed)) {
      if (!prefixes.some((prefix) => image.repository.startsWith(prefix))) continue;
      if (splitRepository(image.repository) === undefined) continue;
      const list = byRepository.get(image.repository) ?? [];
      list.push(image);
      byRepository.set(image.repository, list);
    }
    return byRepository;
  }

  /** Pulls the highest major tag of the registry. */
  private async update(repository: string): Promise<void> {
    let tags: string[];
    try {
      tags = await this.tags(repository);
    } catch (error) {
      this.deps.log(`The tags of ${repository} could not be read; it is not updated: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const major = highestMajorTag(tags);
    if (major === undefined) return;
    const reference = `${repository}:${major}`;
    const before = await this.imageId(reference);
    // Plan step 11I (U1, decision of 2026-10-08): the pull of the engine without a login (anonymous, as `docker pull
    // --quiet` of the monitor's CLI, which had none); an error in its stream fails it as an exit code did.
    try {
      await this.deps.engine.pull(reference, { signal: AbortSignal.timeout(IMAGE_PULL_TIMEOUT_MS) });
    } catch (error) {
      this.deps.log(`${reference} could not be pulled: ${engineFailure(error, IMAGE_PULL_TIMEOUT_MS)}`);
      return;
    }
    // Review round 6 of PR #57 (F1): the image that the pull replaced, also when Docker lists it without its repository.
    const now = await this.imageId(reference);
    if (before !== undefined && now !== undefined && before !== now) {
      this.replaced[repository] = trimReplaced([...(this.replaced[repository] ?? []).filter((id) => id !== before), before], new Set([now]));
      await this.deps.replaced?.write(this.replaced).catch(() => undefined);
    }
  }

  /**
   * Review round 1 of PR #57 (G): the layers of every image of the engine, by ID; undefined when they cannot be read.
   * Docker removes the tag of an image that another image is built on (an environment image) and keeps the image, so
   * the maintenance itself leaves such an image alone.
   */
  private async layersById(): Promise<Map<string, string[]> | undefined> {
    // Plan step 11I (U1, decision of 2026-10-08): the IDs of the list of the engine (as `docker image ls -a -q`; without
    // `all`, an intermediate image of the classic builder is left out, while the image built on it, whose layers start
    // with the same ones, is listed), then the inspect of each (as `docker image inspect` of chunks of IDs).
    let ids: string[];
    try {
      ids = [...new Set((await this.deps.engine.images({}, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS))).map((image) => image.id).filter((id) => IMAGE_ID.test(id)))];
    } catch {
      return undefined;
    }
    const byId = new Map<string, string[]>();
    for (const id of ids) {
      const inspected = await this.inspectImage(id);
      // An image removed meanwhile, or an engine that does not answer: nothing is removed in this pass.
      if (inspected === undefined) return undefined;
      const layers = inspected.RootFS?.Layers;
      if (Array.isArray(layers) && layers.every((layer) => typeof layer === 'string')) byId.set(typeof inspected.Id === 'string' ? inspected.Id : id, layers as string[]);
    }
    return byId;
  }

  /**
   * Removes every version but the KEPT_IMAGE_VERSIONS newest that no container uses and that no other image is built on
   * (its layers are the start of the layers of another image). `layers` undefined: nothing is removed.
   */
  /**
   * The versions of a repository, newest first. Review round 2 of PR #57 (R4): an ID whose tags are no versions (only
   * `latest`, `2.0.14-amd64`) is no version of the line that the monitor pulls: it neither takes one of the kept places
   * nor is removed.
   */
  private versions(images: readonly LocalImage[]): ImageVersion[] {
    return versionsOf(images).filter((version) => version.version !== undefined || version.tags.length === 0);
  }

  private async clean(repository: string, images: readonly LocalImage[], layers: Map<string, string[]> | undefined, kept: ReadonlySet<string>): Promise<void> {
    for (const version of this.versions(images).slice(KEPT_IMAGE_VERSIONS)) {
      if (kept.has(version.id)) continue;
      const label = version.tags.length > 0 ? version.tags.join(', ') : version.id.slice(0, 19);
      const own = layers?.get(version.id);
      if (!layers || !own) {
        this.deps.log(`The older image ${repository} (${label}) stays: its layers could not be read.`);
        continue;
      }
      const builtOn = [...layers].some(([id, other]) => id !== version.id && other.length > own.length && own.every((layer, index) => other[index] === layer));
      if (builtOn) {
        this.deps.log(`The older image ${repository} (${label}) stays: another image is built on it.`);
        continue;
      }
      // Plan step 11I (U1, decision of 2026-10-08): the containers of the image or of one built on it, stopped ones
      // included (as `docker ps -a -q --filter ancestor=<id>`); one, or a list that fails, keeps it.
      let users: string[];
      try {
        users = await this.deps.engine.containerIds({ ancestor: [version.id] }, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS));
      } catch {
        continue;
      }
      if (users.length > 0) continue;
      // By its references in this repository, then by its ID when no reference is left; never with force.
      const references = version.tags.map((tag) => `${repository}:${tag}`);
      const failure = await this.removeReferences(references.length > 0 ? references : [version.id]);
      if (failure === undefined) this.deps.log(`Removed the older image ${repository} (${label}).`);
      else this.deps.log(`The older image ${repository} (${label}) stays: ${failure}`);
    }
  }

  /**
   * Plan step 11I (U1, decision of 2026-10-08): `docker image rm <references…>` over the Engine API: one DELETE of each
   * reference without force (the engine removes the untagged parents with it, as the CLI asks), each tried even after a
   * refusal, all within one time limit. Undefined when the engine removed every one; else the reason of the first that it
   * did not remove, as the first line of the CLI's errors: an image in use (409) or one that is gone (404) is an answer of
   * the engine (removeImage), any other failure its message.
   */
  private async removeReferences(references: readonly string[]): Promise<string | undefined> {
    const signal = AbortSignal.timeout(IMAGE_REMOVE_TIMEOUT_MS);
    let failure: string | undefined;
    for (const reference of references) {
      let reason: string | undefined;
      try {
        const outcome = await this.deps.engine.removeImage(reference, signal);
        if (outcome === 'inUse') reason = `${reference} is in use (a container, or an image built on it); the engine answered 409.`;
        else if (outcome === 'missing') reason = `No such image: ${reference}`;
      } catch (error) {
        reason = engineFailure(error, IMAGE_REMOVE_TIMEOUT_MS);
      }
      failure ??= reason;
    }
    return failure;
  }

  /** The tags of a repository at its registry, anonymous with the token of its challenge; all pages. */
  private async tags(repository: string): Promise<string[]> {
    const parts = splitRepository(repository);
    if (!parts) throw new Error('no registry');
    const base = `https://${parts.registry}`;
    let url: string | undefined = `${base}/v2/${parts.path}/tags/list`;
    let token: string | undefined;
    const tags: string[] = [];
    for (let page = 0; url !== undefined && page < MAX_TAG_PAGES; page++) {
      let answer = await this.deps.httpGet(url, token ? { authorization: `Bearer ${token}` } : {});
      if (answer.status === 401 && token === undefined) {
        const challenge = parseBearerChallenge(answer.headers['www-authenticate']);
        if (!challenge) throw new Error(`HTTP 401 without a Bearer challenge`);
        const query = new URLSearchParams();
        if (challenge.service) query.set('service', challenge.service);
        query.set('scope', challenge.scope ?? `repository:${parts.path}:pull`);
        const tokenAnswer = await this.deps.httpGet(`${challenge.realm}?${query.toString()}`, {});
        if (tokenAnswer.status !== 200) throw new Error(`the token of the registry: HTTP ${tokenAnswer.status}`);
        const parsed = JSON.parse(tokenAnswer.body) as { token?: unknown; access_token?: unknown };
        const value = typeof parsed.token === 'string' ? parsed.token : typeof parsed.access_token === 'string' ? parsed.access_token : undefined;
        if (!value) throw new Error('the registry gave no token');
        token = value;
        answer = await this.deps.httpGet(url, { authorization: `Bearer ${token}` });
      }
      if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
      const body = JSON.parse(answer.body) as { tags?: unknown };
      if (Array.isArray(body.tags)) for (const tag of body.tags) if (typeof tag === 'string') tags.push(tag);
      // The next page (RFC 5988 Link), only on the same registry.
      const next = /<([^>]+)>;\s*rel="next"/.exec(answer.headers.link ?? '')?.[1];
      url = next === undefined ? undefined : new URL(next, base).origin === base ? new URL(next, base).toString() : undefined;
    }
    return tags;
  }
}

/** The prefixes that the container got (DEVENV_IMAGE_PREFIXES, a JSON array); none when missing or invalid. */
export function prefixesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const text = env.DEVENV_IMAGE_PREFIXES;
  if (!text) return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? imagePrefixesOf(value) : [];
  } catch {
    return [];
  }
}
