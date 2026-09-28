// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The images of the Session Monitor on a remote Docker host (user requests 2026-09-28: "the monitor tasks shall look for
// all devcontainer-dev* and devcontainer-classroom* images and shall regularly pull these images as when new updates are
// available … always the latest major version image"; "the monitor shall only keep the two latest versions of these
// images and clean the images from docker regularly"; "only in the remote scenario"; "1 minute after the monitor starts
// then in the morning again, at 6:07 CEST"; "a setting that tells the monitor to fetch in a guided cron style manner"). A
// pass one minute after the start of the monitor, then at each time of the cron schedule of the setting
// remoteImageUpdateSchedule (default `7 6 * * *`: 06:07) in the time zone of the computer that created the monitor:
//   1. The repositories whose name starts with one of the prefixes (the setting remoteImageUpdates): those on the engine,
//      and those of the list that the extension sent ("all images": the registry lists no repositories without a token,
//      so the extension reads the packages with its GitHub session and sends only the names; `monitor.js images -`).
//   2. For each: the tags of the registry (anonymous, the token of its challenge); the highest major tag (a plain number,
//      for example `2`) is pulled (`docker pull <repository>:<major>`: the engine downloads only what changed).
//   3. For each: the two newest versions stay (an image ID is one version: its highest version tag, a shorter tag such as
//      `2` or `latest` above the longer ones of its line, else its creation time); every older one is removed when no
//      container uses it and no other image is built on it (an environment image: its layers start with those of the
//      older one), without force.
// Only Node.js built-ins. Never throws; each problem is one line of the log.
import * as https from 'https';
import { DEFAULT_IMAGE_SCHEDULE, DEFAULT_IMAGE_TIME_ZONE, isTimeZone, nextCronTime, parseCronSchedule } from '../core/remoteMonitor/cron';
import { imagePrefixesOf } from '../core/remoteMonitor/protocol';
import type { DockerRunner } from './main';

export { DEFAULT_IMAGE_SCHEDULE, DEFAULT_IMAGE_TIME_ZONE, imagePrefixesOf, isTimeZone, nextCronTime, parseCronSchedule };

/** Time from the start of the monitor to the first pass. */
export const REMOTE_IMAGE_FIRST_PASS_MS = 60_000;
/** The number of versions of a repository that stay. */
export const KEPT_IMAGE_VERSIONS = 2;
/** Time limits. */
export const IMAGE_LIST_TIMEOUT_MS = 60_000;
export const IMAGE_PULL_TIMEOUT_MS = 60 * 60_000;
export const IMAGE_REMOVE_TIMEOUT_MS = 120_000;
export const REGISTRY_TIMEOUT_MS = 30_000;
/** The longest answer of a registry that is read. */
const MAX_REGISTRY_BODY = 4 * 1024 * 1024;
/** At most this many images per `docker image inspect`. */
const INSPECT_CHUNK = 100;
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
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.destroy();
      reject(error);
    };
    const deadline = setTimeout(() => fail(new Error('The registry did not answer in time.')), timeoutMs);
    const request = get(url, { headers, timeout: timeoutMs }, (response) => {
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
    });
    request.on('timeout', () => fail(new Error('The registry did not answer in time.')));
    request.on('error', (error) => fail(error));
  });
}

/** One image of `docker image ls`. */
export interface LocalImage {
  repository: string;
  /** `<none>` for an untagged image. */
  tag: string;
  id: string;
  /** Creation time as Docker prints it; compared as text (the same form for all images). */
  createdAt: string;
}

/** The images of `docker image ls --no-trunc --format '{{json .}}'`, one JSON object per line. */
export function parseImageList(stdout: string): LocalImage[] {
  const images: LocalImage[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const item = JSON.parse(line) as Record<string, unknown>;
      const { Repository, Tag, ID, CreatedAt } = item;
      if (typeof Repository === 'string' && typeof Tag === 'string' && typeof ID === 'string' && typeof CreatedAt === 'string') {
        images.push({ repository: Repository, tag: Tag, id: ID, createdAt: CreatedAt });
      }
    } catch {
      // A line that is no JSON object is left out.
    }
  }
  return images;
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
    const x = a[index] ?? Number.POSITIVE_INFINITY;
    const y = b[index] ?? Number.POSITIVE_INFINITY;
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
    return b.createdAt.localeCompare(a.createdAt);
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
  docker: DockerRunner;
  httpGet: HttpGet;
  log: (message: string) => void;
  /**
   * The prefixes of the pass: those of the container (DEVENV_IMAGE_PREFIXES), or the newer ones that an extension sent
   * (`monitor.js settings -`; review round 1 of PR #57, C: the settings are not part of the label anymore).
   */
  prefixes: () => readonly string[];
  /** The repositories of the list that the extension sent (none when it sent none). */
  knownRepositories: () => Promise<string[]>;
}

/** The passes of the image maintenance. */
export class ImageMaintenance {
  constructor(private readonly deps: ImageMaintenanceDeps) {}

  /** One pass: the pulls, then the removal of the older versions. Never throws. */
  async pass(): Promise<void> {
    const prefixes = this.deps.prefixes();
    if (prefixes.length === 0) return;
    try {
      const local = await this.repositories(prefixes);
      const known = (await this.deps.knownRepositories()).filter((repository) => prefixes.some((prefix) => repository.startsWith(prefix)));
      for (const repository of new Set([...local.keys(), ...known])) await this.update(repository);
      const after = await this.repositories(prefixes);
      const layers = after.size > 0 ? await this.layersById() : new Map<string, string[]>();
      for (const [repository, images] of after) await this.clean(repository, images, layers);
    } catch (error) {
      this.deps.log(`The images could not be maintained: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The images of the repositories with one of the prefixes, by repository. */
  private async repositories(prefixes: readonly string[]): Promise<Map<string, LocalImage[]>> {
    const listed = await this.deps.docker(['image', 'ls', '--no-trunc', '--format', '{{json .}}'], IMAGE_LIST_TIMEOUT_MS);
    if (listed.code !== 0) throw new Error(`docker image ls failed: ${listed.stderr.trim()}`);
    const byRepository = new Map<string, LocalImage[]>();
    for (const image of parseImageList(listed.stdout)) {
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
    const pulled = await this.deps.docker(['pull', '--quiet', reference], IMAGE_PULL_TIMEOUT_MS);
    if (pulled.code !== 0) this.deps.log(`${reference} could not be pulled: ${pulled.stderr.trim() || `exit code ${pulled.code}`}`);
  }

  /**
   * Review round 1 of PR #57 (G): the layers of every image of the engine, by ID; undefined when they cannot be read.
   * Docker removes the tag of an image that another image is built on (an environment image) and keeps the image, so
   * the maintenance itself leaves such an image alone.
   */
  private async layersById(): Promise<Map<string, string[]> | undefined> {
    const listed = await this.deps.docker(['image', 'ls', '-a', '-q', '--no-trunc'], IMAGE_LIST_TIMEOUT_MS);
    if (listed.code !== 0) return undefined;
    const ids = [...new Set(listed.stdout.split('\n').map((line) => line.trim()).filter((id) => /^[A-Za-z0-9:]{1,100}$/.test(id)))];
    const byId = new Map<string, string[]>();
    for (let start = 0; start < ids.length; start += INSPECT_CHUNK) {
      const inspected = await this.deps.docker(['image', 'inspect', '--format', '{{.Id}} {{json .RootFS.Layers}}', ...ids.slice(start, start + INSPECT_CHUNK)], IMAGE_LIST_TIMEOUT_MS);
      // An image removed meanwhile: nothing is removed in this pass.
      if (inspected.code !== 0) return undefined;
      for (const line of inspected.stdout.split('\n')) {
        const match = /^(\S+) (\[.*\])$/.exec(line.trim());
        if (!match) continue;
        try {
          const layers = JSON.parse(match[2]) as unknown;
          if (Array.isArray(layers) && layers.every((layer) => typeof layer === 'string')) byId.set(match[1], layers as string[]);
        } catch {
          // Not such a line.
        }
      }
    }
    return byId;
  }

  /**
   * Removes every version but the KEPT_IMAGE_VERSIONS newest that no container uses and that no other image is built on
   * (its layers are the start of the layers of another image). `layers` undefined: nothing is removed.
   */
  private async clean(repository: string, images: readonly LocalImage[], layers: Map<string, string[]> | undefined): Promise<void> {
    // Review round 2 of PR #57 (R4): an ID whose tags are no versions (only `latest`, `2.0.14-amd64`) is no version of the
    // line that the monitor pulls: it neither takes one of the kept places nor is removed.
    const versions = versionsOf(images).filter((version) => version.version !== undefined || version.tags.length === 0);
    for (const version of versions.slice(KEPT_IMAGE_VERSIONS)) {
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
      const users = await this.deps.docker(['ps', '-a', '-q', '--filter', `ancestor=${version.id}`], IMAGE_LIST_TIMEOUT_MS);
      if (users.code !== 0 || users.stdout.trim() !== '') continue;
      // By its references in this repository, then by its ID when no reference is left; never with force.
      const references = version.tags.map((tag) => `${repository}:${tag}`);
      const removed = await this.deps.docker(['image', 'rm', ...(references.length > 0 ? references : [version.id])], IMAGE_REMOVE_TIMEOUT_MS);
      if (removed.code === 0) this.deps.log(`Removed the older image ${repository} (${label}).`);
      else this.deps.log(`The older image ${repository} (${label}) stays: ${removed.stderr.trim().split('\n')[0] ?? ''}`);
    }
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
