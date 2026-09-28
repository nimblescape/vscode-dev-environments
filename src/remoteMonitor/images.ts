// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The images of the Session Monitor on a remote Docker host (user requests 2026-09-28: "the monitor tasks shall look for
// all devcontainer-dev* and devcontainer-classroom* images and shall regularly pull these images as when new updates are
// available … always the latest major version image"; "the monitor shall only keep the two latest versions of these
// images and clean the images from docker regularly"; "only in the remote scenario"; "1 minute after the monitor starts
// then in the morning again, at 6:07 CEST"). A pass one minute after the start of the monitor, then every day at the
// time of the setting remoteImageUpdateTime (06:07) in the time zone of the computer that created the monitor:
//   1. The repositories whose name starts with one of the prefixes (the setting remoteImageUpdates): those on the engine,
//      and those of the list that the extension sent ("all images": the registry lists no repositories without a token,
//      so the extension reads the packages with its GitHub session and sends only the names; `monitor.js images -`).
//   2. For each: the tags of the registry (anonymous, the token of its challenge); the highest major tag (a plain number,
//      for example `2`) is pulled (`docker pull <repository>:<major>`: the engine downloads only what changed).
//   3. For each: the two newest versions stay (an image ID is one version: its highest version tag, else its creation
//      time); every older one is removed when no container uses it, without force, so Docker itself refuses an image
//      that a container or another image (an environment built on it) still needs.
// Only Node.js built-ins. Never throws; each problem is one line of the log.
import * as https from 'https';
import { imagePrefixesOf } from '../core/remoteMonitor/protocol';
import type { DockerRunner } from './main';

export { imagePrefixesOf };

/** Time from the start of the monitor to the first pass. */
export const REMOTE_IMAGE_FIRST_PASS_MS = 60_000;
/** The default time of the daily pass (the setting remoteImageUpdateTime) and its time zone. */
export const DEFAULT_IMAGE_TIME = '06:07';
export const DEFAULT_IMAGE_TIME_ZONE = 'Europe/Vienna';

/** A time of day `HH:MM` (00:00..23:59). */
export function parseTimeOfDay(text: string | undefined): { hour: number; minute: number } | undefined {
  const match = text === undefined ? null : /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(text);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : undefined;
}

/** True for a time zone that this Node.js knows (an IANA name such as Europe/Vienna). */
export function isTimeZone(value: string | undefined): value is string {
  if (!value || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of `time` in `timeZone`, as if it were UTC (ms). */
function wallClock(time: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(time))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * The next moment after `now` at which the wall clock of `timeZone` shows `hour:minute` (daylight saving time
 * included: 06:07 is 04:07 UTC in summer and 05:07 UTC in winter in Europe/Vienna).
 */
export function nextTimeOfDay(now: number, hour: number, minute: number, timeZone: string): number {
  const today = wallClock(now, timeZone);
  const day = Date.UTC(new Date(today).getUTCFullYear(), new Date(today).getUTCMonth(), new Date(today).getUTCDate());
  for (let offsetDays = 0; offsetDays <= 2; offsetDays++) {
    const wall = day + offsetDays * 86_400_000 + (hour * 60 + minute) * 60_000;
    // The offset of the zone at about that time, then once more at the result (a change of the offset in between).
    let candidate = wall - (wallClock(wall, timeZone) - wall);
    candidate = wall - (wallClock(candidate, timeZone) - candidate);
    if (candidate > now) return candidate;
  }
  return now + 86_400_000;
}
/** The number of versions of a repository that stay. */
export const KEPT_IMAGE_VERSIONS = 2;
/** Time limits. */
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

export const nodeHttpGet: HttpGet = (url, headers) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, { headers, timeout: REGISTRY_TIMEOUT_MS }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_REGISTRY_BODY) request.destroy(new Error('The answer of the registry is too large.'));
      });
      response.on('end', () => {
        const flat: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) flat[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        resolve({ status: response.statusCode ?? 0, headers: flat, body });
      });
    });
    request.on('timeout', () => request.destroy(new Error('The registry did not answer in time.')));
    request.on('error', reject);
  });

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

/** A version tag as numbers (`2.0.14` → [2, 0, 14]); undefined for any other tag (`latest`, `2.0.14-amd64`). */
function versionOf(tag: string): number[] | undefined {
  return /^[0-9]{1,6}(\.[0-9]{1,6}){0,3}$/.test(tag) ? tag.split('.').map(Number) : undefined;
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) return difference;
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
 * The versions of one repository, newest first: an ID with a version tag is newer than one without; between two with
 * one, the higher version; else the later creation time.
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
  prefixes: readonly string[];
  /** The repositories of the list that the extension sent (none when it sent none). */
  knownRepositories: () => Promise<string[]>;
}

/** The passes of the image maintenance. */
export class ImageMaintenance {
  constructor(private readonly deps: ImageMaintenanceDeps) {}

  /** One pass: the pulls, then the removal of the older versions. Never throws. */
  async pass(): Promise<void> {
    if (this.deps.prefixes.length === 0) return;
    try {
      const local = await this.repositories();
      const known = (await this.deps.knownRepositories()).filter((repository) => this.deps.prefixes.some((prefix) => repository.startsWith(prefix)));
      for (const repository of new Set([...local.keys(), ...known])) await this.update(repository);
      const after = await this.repositories();
      for (const [repository, images] of after) await this.clean(repository, images);
    } catch (error) {
      this.deps.log(`The images could not be maintained: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The images of the repositories with one of the prefixes, by repository. */
  private async repositories(): Promise<Map<string, LocalImage[]>> {
    const listed = await this.deps.docker(['image', 'ls', '--no-trunc', '--format', '{{json .}}'], IMAGE_LIST_TIMEOUT_MS);
    if (listed.code !== 0) throw new Error(`docker image ls failed: ${listed.stderr.trim()}`);
    const byRepository = new Map<string, LocalImage[]>();
    for (const image of parseImageList(listed.stdout)) {
      if (!this.deps.prefixes.some((prefix) => image.repository.startsWith(prefix))) continue;
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

  /** Removes every version but the KEPT_IMAGE_VERSIONS newest that no container uses. */
  private async clean(repository: string, images: readonly LocalImage[]): Promise<void> {
    const versions = versionsOf(images);
    for (const version of versions.slice(KEPT_IMAGE_VERSIONS)) {
      const users = await this.deps.docker(['ps', '-a', '-q', '--filter', `ancestor=${version.id}`], IMAGE_LIST_TIMEOUT_MS);
      if (users.code !== 0 || users.stdout.trim() !== '') continue;
      // By its references in this repository, then by its ID when no reference is left; never with force.
      const references = version.tags.map((tag) => `${repository}:${tag}`);
      const removed = await this.deps.docker(['image', 'rm', ...(references.length > 0 ? references : [version.id])], IMAGE_REMOVE_TIMEOUT_MS);
      const label = version.tags.length > 0 ? version.tags.join(', ') : version.id.slice(0, 19);
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
