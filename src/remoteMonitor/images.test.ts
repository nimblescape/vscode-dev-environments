// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it, vi } from 'vitest';
import type { HttpResponse, HttpTransport } from '../core/http';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { abortError } from '../core/ports';
import { EngineError, type EngineFilters, type EngineImage } from '../core/worker/dockerEngine';
import { MAX_ENGINE_LIST_ANSWER_CHARACTERS, type EngineApi, type EngineAnswer, type EngineRequest } from '../helperChannel/engineApi';
import { dockerEngine } from '../helperChannel/engineClient';
import type { ImageEngine } from './engine';
import { imagePrefixesOf } from '../core/remoteMonitor/protocol';
import {
  IMAGE_LIST_TIMEOUT_MS,
  IMAGE_PULL_TIMEOUT_MS,
  IMAGE_REMOVE_TIMEOUT_MS,
  ImageMaintenance,
  highestMajorTag,
  localImagesOf,
  parseReplacedImages,
  prefixesFromEnv,
  pruneReplacedImages,
  requestsWithin,
  splitRepository,
  versionsOf,
  type LocalImage,
  type ReplacedImages,
} from './images';

const DEV = 'ghcr.io/majikmate/devcontainer-dev';
const WEB = 'ghcr.io/majikmate/devcontainer-classroom-web';
const PREFIXES = ['ghcr.io/majikmate/devcontainer-classroom', 'ghcr.io/majikmate/devcontainer-dev'];

/**
 * One row of `docker image ls` (a repository and a tag of an image; `<none>`: the image has only a digest of the
 * repository). Plan step 11I (U1, decision of 2026-10-08): an object instead of the JSON line of the CLI; the fake engine
 * lists the rows of an ID as one image with its references.
 */
function image(repository: string, tag: string, id: string, createdAt: string): LocalImage {
  return { repository, tag, id, createdAt };
}

/**
 * The engine of the test over the port (plan step 11I, U1, decision of 2026-10-08; before: the Docker CLI with its
 * arguments): its images, the containers per image, and the calls, each as the name of the method and its argument.
 * Review round 1 of PR #57 (G): `layers` of an image ID (default: one layer of its own, no image built on another).
 * `failInspect`: every inspect answers that the image does not exist (an image removed meanwhile; the stderr of the CLI
 * before). `failRemove`: references whose removal the engine refuses as in use (409; an exit code of `docker image rm`
 * with the conflict before, which removed none of its references).
 */
function fakeEngine(options: {
  images: LocalImage[];
  usedBy?: Record<string, string>;
  failRemove?: string[];
  layers?: Record<string, string[]>;
  failInspect?: boolean;
  pulled?: Record<string, string>;
  dangling?: Record<string, string>;
}) {
  const calls: string[][] = [];
  /** The arguments of each call of removeImage (the reference and the signal: no force). */
  const removals: unknown[][] = [];
  /** The options of each pull (no login). */
  const pulls: unknown[] = [];
  let images = [...options.images];
  /** The images of the list of the engine: one per ID, a row with a tag as `repository:tag`, one without as a digest. */
  const listed = (): EngineImage[] => {
    const byId = new Map<string, EngineImage>();
    for (const row of images) {
      const entry = byId.get(row.id) ?? { id: row.id, repoTags: [], repoDigests: [], labels: {}, created: row.createdAt };
      byId.set(row.id, entry);
      if (row.tag === '<none>') entry.repoDigests.push(`${row.repository}@sha256:${'d'.repeat(64)}`);
      else entry.repoTags.push(`${row.repository}:${row.tag}`);
    }
    // The IDs of other images of the engine (built on one of the repositories), and of images that it lists without
    // a reference (the containerd image store after a pull replaced them).
    for (const id of [...Object.keys(options.layers ?? {}), ...Object.keys(options.dangling ?? {})]) {
      if (!byId.has(id)) byId.set(id, { id, repoTags: [], repoDigests: [], labels: {}, created: options.dangling?.[id] ?? '2026-01-01T00:00:00Z' });
    }
    return [...byId.values()];
  };
  const engine: ImageEngine = {
    images: async (filters: EngineFilters) => {
      calls.push(['images', JSON.stringify(filters)]);
      return listed();
    },
    // Review round 6 of PR #57 (F1): the ID of a reference, and the tags and time of an ID (`pulled`: what a pull of a
    // reference makes it point to; `dangling`: images that Docker lists without their repository, as the containerd
    // image store does after a pull replaced them), and the layers of an ID: the inspect JSON of the engine.
    inspect: async (kind, reference) => {
      calls.push(['inspect', reference]);
      if (kind !== 'image') throw new Error(`unexpected inspect of a ${kind}`);
      if (options.failInspect) return undefined;
      const id = images.find((row) => row.tag !== '<none>' && `${row.repository}:${row.tag}` === reference)?.id ?? reference;
      const rows = images.filter((row) => row.id === id);
      const dangling = options.dangling?.[id];
      if (rows.length === 0 && dangling === undefined && options.layers?.[id] === undefined) return undefined;
      const tags = rows.filter((row) => row.tag !== '<none>').map((row) => `${row.repository}:${row.tag}`);
      return { Id: id, RepoTags: tags, Created: dangling ?? rows[0]?.createdAt ?? '2026-01-01T00:00:00Z', RootFS: { Type: 'layers', Layers: options.layers?.[id] ?? [`${id}/layer`] } };
    },
    pull: async (reference, pullOptions) => {
      calls.push(['pull', reference]);
      pulls.push(pullOptions);
      // A pull that moves the reference to a new image: the old one loses it (containerd: listed without repository).
      const target = options.pulled?.[reference];
      if (target !== undefined) {
        const [repository, tag] = [reference.slice(0, reference.lastIndexOf(':')), reference.slice(reference.lastIndexOf(':') + 1)];
        images = images.filter((row) => !(row.repository === repository && row.tag === tag));
        images.push(image(repository, tag, target, '2026-09-28'));
      }
    },
    containerIds: async (filters) => {
      calls.push(['containerIds', JSON.stringify(filters)]);
      const id = filters.ancestor?.[0] ?? '';
      return options.usedBy?.[id] === undefined ? [] : [options.usedBy[id]];
    },
    removeImage: async (...args) => {
      const [reference] = args;
      calls.push(['removeImage', reference]);
      removals.push(args);
      if (options.failRemove?.includes(reference)) return 'inUse';
      const before = images.length;
      images = images.filter((row) => `${row.repository}:${row.tag}` !== reference && row.id !== reference);
      return images.length < before ? 'removed' : 'missing';
    },
  };
  return { engine, calls, removals, pulls };
}

/** Plan step 11I (U1): the calls of removeImage of a fake engine (`docker image rm` before). */
const removed = (calls: string[][]): string[][] => calls.filter((call) => call[0] === 'removeImage');

/**
 * A registry that wants a token from its challenge, then lists `tags` per repository path. Cleanup C5 (plan step 11J,
 * C1): a transport of the worker's registry client, which the image maintenance now uses (before: an HttpGet of the
 * monitor's own client); the same answers.
 */
function fakeRegistry(tags: Record<string, string[]>) {
  const requests: Array<{ url: string; auth?: string }> = [];
  const request = async ({ url, headers = {} }: { url: string; headers?: Record<string, string> }): Promise<HttpResponse> => {
    requests.push({ url, auth: headers.Authorization });
    if (url.startsWith('https://ghcr.io/token?')) return { status: 200, headers: {}, body: JSON.stringify({ token: 'anon-token' }) };
    const match = /^https:\/\/ghcr\.io\/v2\/(.+)\/tags\/list$/.exec(url);
    if (!match) return { status: 404, headers: {}, body: '' };
    if (headers.Authorization !== 'Bearer anon-token') {
      return {
        status: 401,
        headers: { 'www-authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${match[1]}:pull"` },
        body: '',
      };
    }
    const list = tags[match[1]];
    return list ? { status: 200, headers: {}, body: JSON.stringify({ name: match[1], tags: list }) } : { status: 404, headers: {}, body: '' };
  };
  return { transport: (): HttpTransport => ({ request }), requests };
}

describe('the images of the remote Session Monitor (user requests 2026-09-28)', () => {
  it('reads the prefixes of the setting: a trailing * dropped, invalid ones left out', () => {
    expect(imagePrefixesOf(['ghcr.io/majikmate/devcontainer-dev*', 'ghcr.io/majikmate/devcontainer-dev', 'no-registry*', 'GHCR.io/x*', 3])).toEqual([
      'ghcr.io/majikmate/devcontainer-dev',
    ]);
    expect(prefixesFromEnv({ DEVENV_IMAGE_PREFIXES: JSON.stringify(PREFIXES) })).toEqual(PREFIXES);
    expect(prefixesFromEnv({ DEVENV_IMAGE_PREFIXES: 'not json' })).toEqual([]);
    expect(prefixesFromEnv({})).toEqual([]);
    // Review round 8 of PR #57 (S4): Docker Hub is not supported (`docker image ls` lists its images without registry).
    expect(imagePrefixesOf(['docker.io/library/ubuntu*', 'index.docker.io/x/y*', 'registry-1.docker.io/x/y*'])).toEqual([]);
    // Nor a name without a registry host (it would never match either).
    expect(imagePrefixesOf(['owner/repo*', 'localhost:5000/a/b*', 'registry:5000/x*'])).toEqual(['localhost:5000/a/b', 'registry:5000/x']);
    // Review round 5 of PR #57 (P1): at most 50, as the monitor takes with `settings -`.
    const many = Array.from({ length: 60 }, (_, index) => `ghcr.io/acme/image-${index}*`);
    expect(imagePrefixesOf(many)).toHaveLength(50);
    expect(prefixesFromEnv({ DEVENV_IMAGE_PREFIXES: JSON.stringify(many) })).toHaveLength(50);
    // Review round 6 of PR #57 (F2): at most 128 characters each, 4096 as JSON together (the command line of the monitor).
    expect(imagePrefixesOf([`ghcr.io/${'a'.repeat(121)}*`, `ghcr.io/${'a'.repeat(120)}*`])).toEqual([`ghcr.io/${'a'.repeat(120)}`]);
    const long = Array.from({ length: 50 }, (_, index) => `ghcr.io/${String(index).padStart(2, '0')}${'a'.repeat(118)}*`);
    expect(JSON.stringify(imagePrefixesOf(long)).length).toBeLessThanOrEqual(4096);
  });

  it('takes the highest plain major tag (the registry has latest, 2, 2.0, 2.0.14, 2.0.14-amd64)', () => {
    expect(highestMajorTag(['latest', '2.0', '2', '2.0.14-amd64', '2.0.14', '1', '10'])).toBe('10');
    expect(highestMajorTag(['latest', '2.0.14'])).toBeUndefined();
    expect(highestMajorTag(['01', '2'])).toBe('2');
  });

  it('orders the versions of a repository newest first: version tags, then the creation time', () => {
    // Plan step 11I (U1, decision of 2026-10-08): changed fixture, the images of the list of the engine (localImagesOf;
    // was the lines of `docker image ls --format '{{json .}}'` with the times of the CLI, parseImageList, and a line that
    // was no JSON, which a list of the engine has no counterpart of: an entry without an ID is left out by the port,
    // engineClient.test.ts). The same images and times, so the same order.
    const images: LocalImage[] = localImagesOf([
      { id: 'sha256:b', repoTags: [`${DEV}:2.0.13`], repoDigests: [], labels: {}, created: '2026-09-01T10:00:00.000Z' },
      { id: 'sha256:c', repoTags: [`${DEV}:2`, `${DEV}:2.0.14`], repoDigests: [`${DEV}@sha256:${'c'.repeat(64)}`], labels: {}, created: '2026-09-20T10:00:00.000Z' },
      { id: 'sha256:a', repoTags: [`${DEV}:1.9.0`], repoDigests: [], labels: {}, created: '2026-10-01T10:00:00.000Z' },
      { id: 'sha256:d', repoTags: [], repoDigests: [`${DEV}@sha256:${'d'.repeat(64)}`], labels: {}, created: '2026-09-25T10:00:00.000Z' },
    ]);
    expect(versionsOf(images).map((version) => [version.id, version.tags])).toEqual([
      ['sha256:c', ['2', '2.0.14']],
      ['sha256:b', ['2.0.13']],
      ['sha256:a', ['1.9.0']],
      ['sha256:d', []],
    ]);
  });

  it('splits a repository and reads a Bearer challenge', async () => {
    expect(splitRepository(DEV)).toEqual({ registry: 'ghcr.io', path: 'majikmate/devcontainer-dev' });
    expect(splitRepository('library/ubuntu')).toBeUndefined();
    // Cleanup C5 (plan step 11J, C1): changed expectation, the challenge is read by the worker's registry client
    // (listTags) instead of the monitor's parseBearerChallenge: its realm, service and scope make the token request; a
    // realm without TLS gets no request; a Basic challenge without credentials (the monitor has none) is no token.
    const tokens: string[] = [];
    const answering = (challenge: string): HttpTransport => ({
      request: async ({ url }): Promise<HttpResponse> => {
        if (url.includes('/v2/')) return { status: 401, headers: { 'www-authenticate': challenge }, body: '' };
        tokens.push(url);
        return { status: 200, headers: {}, body: JSON.stringify({ token: 't' }) };
      },
    });
    const tagsWith = (challenge: string) => new RegistryClient(answering(challenge), async () => undefined).listTags('ghcr.io', 'a/b');
    await tagsWith('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"');
    expect(tokens).toEqual(['https://ghcr.io/token?service=ghcr.io&scope=repository%3Aa%2Fb%3Apull']);
    // Only https realms.
    expect(await tagsWith('Bearer realm="http://evil/token"')).toEqual({ kind: 'error', registry: 'ghcr.io', error: 'The registry requires an insecure token service (http://evil).' });
    expect(await tagsWith('Basic realm="x"')).toEqual({ kind: 'authRequired', registry: 'ghcr.io' });
    expect(tokens).toHaveLength(1);
  });

  it('pulls the latest major version of each repository on the host and of the list of the extension (all images)', async () => {
    const engine = fakeEngine({
      images: [image(DEV, '2', 'sha256:c', '2026-09-20'), image('ghcr.io/other/base', '1', 'sha256:x', '2026-09-20')],
    });
    const registry = fakeRegistry({ 'majikmate/devcontainer-dev': ['latest', '2', '2.0.14'], 'majikmate/devcontainer-classroom-web': ['1', '2', '3'] });
    const log: string[] = [];
    await new ImageMaintenance({
      engine: engine.engine,
      registryTransport: registry.transport,
      log: (message) => log.push(message),
      prefixes: () => PREFIXES,
      // A repository that the host has no image of yet, and one of no prefix (left out).
      knownRepositories: async () => [WEB, 'ghcr.io/other/base'],
    }).pass();
    // Plan step 11I (U1, decision of 2026-10-08): changed expectation, the pulls of the engine (was `docker pull --quiet
    // <reference>`), without a login (the CLI of the monitor had none) and with their time limit only.
    expect(engine.calls.filter((call) => call[0] === 'pull')).toEqual([
      ['pull', `${DEV}:2`],
      ['pull', `${WEB}:3`],
    ]);
    expect(engine.pulls.map((options) => Object.keys(options as object))).toEqual([['signal'], ['signal']]);
    // The anonymous token of the challenge; the other repository is never asked.
    expect(registry.requests.some((request) => request.url.includes('other'))).toBe(false);
    expect(registry.requests.filter((request) => request.url.startsWith('https://ghcr.io/token?'))[0].url).toContain('scope=repository%3Amajikmate%2Fdevcontainer-dev%3Apull');
    expect(log).toEqual([]);
  });

  it('keeps the two newest versions; removes the older ones by their references, never with force, not when a container uses them', async () => {
    const engine = fakeEngine({
      images: [
        image(DEV, '2', 'sha256:new', '2026-09-20'),
        image(DEV, '2.0.14', 'sha256:new', '2026-09-20'),
        image(DEV, '2.0.13', 'sha256:prev', '2026-09-10'),
        image(DEV, '2.0.12', 'sha256:used', '2026-09-01'),
        image(DEV, '2.0.11', 'sha256:old', '2026-08-01'),
        image(DEV, '<none>', 'sha256:dangling', '2026-07-01'),
        image(DEV, '2.0.10', 'sha256:parent', '2026-06-01'),
      ],
      usedBy: { 'sha256:used': 'container-id\n' },
      failRemove: [`${DEV}:2.0.10`],
    });
    const registry = fakeRegistry({ 'majikmate/devcontainer-dev': ['2'] });
    const log: string[] = [];
    await new ImageMaintenance({ engine: engine.engine, registryTransport: registry.transport, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    // Plan step 11I (U1, decision of 2026-10-08): changed expectation, one removal of the engine per reference (was
    // `docker image rm <references…>`), each with the reference and its time limit only: never with force (was: no `-f`
    // or `--force` among the arguments).
    expect(removed(engine.calls)).toEqual([
      ['removeImage', `${DEV}:2.0.11`],
      ['removeImage', `${DEV}:2.0.10`],
      ['removeImage', 'sha256:dangling'],
    ]);
    expect(engine.removals.every((args) => args.length === 2 && args[1] instanceof AbortSignal)).toBe(true);
    // Plan step 11I (U1): changed expectation, the engine answers 409 for an image in use (was the stderr of the CLI,
    // "Error response from daemon: conflict: image has dependent child images"); the image stays and the log says why.
    expect(log).toEqual([
      `Removed the older image ${DEV} (2.0.11).`,
      `The older image ${DEV} (2.0.10) stays: ${DEV}:2.0.10 is in use (a container, or an image built on it); the engine answered 409.`,
      `Removed the older image ${DEV} (sha256:dangling).`,
    ]);
  });

  // Review round 1 of PR #57 (A): the image just pulled as `:2` (no version tag of its own) ranked below older `2.0.x`
  // images and was removed; an image tagged only `latest` ranked below every version.
  // Review round 2 of PR #57 (R4): `latest` no longer ranks above every version (the monitor never pulls it): an image
  // with only `latest` stays and takes no kept place; the two newest versions stay, the third is removed.
  it('keeps the image just pulled as its major tag above older versions; leaves one of latest alone', async () => {
    const engine = fakeEngine({
      images: [
        image(DEV, '2', 'sha256:new', '2026-09-28'),
        image(DEV, '2.0.14', 'sha256:v14', '2026-09-20'),
        image(DEV, '2.0.13', 'sha256:v13', '2026-09-10'),
        image(WEB, 'latest', 'sha256:wnew', '2026-09-28'),
        image(WEB, '1.0.1', 'sha256:w101', '2020-01-02'),
        image(WEB, '1.0.0', 'sha256:w100', '2020-01-01'),
        image(WEB, '0.9.0', 'sha256:w090', '2019-01-01'),
      ],
    });
    const registry = fakeRegistry({ 'majikmate/devcontainer-dev': ['2', '2.0.15'], 'majikmate/devcontainer-classroom-web': ['1'] });
    const log: string[] = [];
    await new ImageMaintenance({ engine: engine.engine, registryTransport: registry.transport, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    // Plan step 11I (U1, decision of 2026-10-08): changed expectation, the removals of the engine (was `docker image rm`).
    expect(removed(engine.calls)).toEqual([
      ['removeImage', `${DEV}:2.0.13`],
      ['removeImage', `${WEB}:0.9.0`],
    ]);
    // Plan step 11I (U1): the rows as objects (were the lines of the CLI read by parseImageList).
    expect(versionsOf([image(DEV, '2.0', 'sha256:a', '1'), image(DEV, '2.0.14', 'sha256:b', '2'), image(DEV, '3.0.0', 'sha256:c', '0')]).map((version) => version.id)).toEqual([
      'sha256:c',
      'sha256:a',
      'sha256:b',
    ]);
  });

  // Review round 2 of PR #57 (R4): a `latest` that the monitor never pulls took one of the kept places for ever, and the
  // real previous version was removed.
  it('leaves an image with only other tags (latest) alone and does not count it', async () => {
    const engine = fakeEngine({
      images: [
        image(DEV, 'latest', 'sha256:stale', '2025-01-01'),
        image(DEV, '2', 'sha256:new', '2026-09-28'),
        image(DEV, '<none>', 'sha256:prev', '2026-09-20'),
        image(DEV, '<none>', 'sha256:older', '2026-09-01'),
      ],
    });
    const log: string[] = [];
    await new ImageMaintenance({
      engine: engine.engine,
      registryTransport: fakeRegistry({ 'majikmate/devcontainer-dev': ['2'] }).transport,
      log: (message) => log.push(message),
      prefixes: () => PREFIXES,
      knownRepositories: async () => [],
    }).pass();
    // Plan step 11I (U1, decision of 2026-10-08): changed expectation, the removal of the engine (was `docker image rm`).
    expect(removed(engine.calls)).toEqual([['removeImage', 'sha256:older']]);
  });

  // Review round 2 of PR #57 (R5): the idle time limit of the socket alone let a registry that sends a byte now and then,
  // or a connection cut in the middle of an answer, keep a pass (and every later one) open for ever.
  // Cleanup C5 (plan step 11J, C1): changed expectation, the limit of each request is requestsWithin over the transport of
  // the worker's registry client (was: the deadline of the monitor's own httpGetWith; "did not answer in time" is now an
  // AbortError); a transport that never answers (a trickle), one that fails (a cut), and one that answers. The trickle and
  // the cut over real TLS through the proxy of the daemon: images.pC5.test.ts.
  it('the registry request ends within its time limit, also when the answer trickles or is cut', async () => {
    const never: HttpTransport = { request: () => new Promise(() => {}) };
    const started = Date.now();
    await expect(requestsWithin(never, 400).request({ method: 'GET', url: 'https://ghcr.io/v2/' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2_000);
    const cut: HttpTransport = { request: async () => Promise.reject(new Error('aborted')) };
    await expect(requestsWithin(cut, 5_000).request({ method: 'GET', url: 'https://ghcr.io/v2/' })).rejects.toThrow('aborted');
    const ok: HttpTransport = { request: async () => ({ status: 200, headers: {}, body: '{"tags":[]}' }) };
    await expect(requestsWithin(ok, 5_000).request({ method: 'GET', url: 'https://ghcr.io/v2/' })).resolves.toMatchObject({ status: 200, body: '{"tags":[]}' });
    // The signal of the transport ends at the limit, also with a signal of the caller.
    let seen: AbortSignal | undefined;
    const watching: HttpTransport = { request: (_request, signal) => ((seen = signal), new Promise(() => {})) };
    await expect(requestsWithin(watching, 50).request({ method: 'GET', url: 'https://ghcr.io/v2/' }, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen?.aborted).toBe(true);
  });

  // Review round 3 of PR #57 (N1): `get` throws at once for an invalid URL or header; the time limit then ended the
  // monitor with an uncaught error. Cleanup C5 (plan step 11J, C1): changed expectation, over requestsWithin (was:
  // httpGetWith).
  it('a registry request that cannot start rejects and leaves no timer behind', async () => {
    const throwing: HttpTransport = {
      request: () => {
        throw new TypeError('Invalid URL');
      },
    };
    await expect(requestsWithin(throwing, 50).request({ method: 'GET', url: 'https://[bad' })).rejects.toThrow('Invalid URL');
    // Past the time limit: nothing is thrown (vitest fails on an uncaught error).
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  // Review round 6 of PR #57 (F1): with the containerd image store, the image that a pull replaced is listed without its
  // repository; the monitor keeps its ID in the volume and removes it once it is older than the two newest.
  it('removes the images that pulls replaced also when Docker lists them without their repository', async () => {
    const dangling: Record<string, string> = {};
    const engine = fakeEngine({ images: [image(DEV, '2', 'sha256:v1', '2026-09-01')], pulled: { [`${DEV}:2`]: 'sha256:v2' }, dangling });
    let stored: ReplacedImages = {};
    const replaced = { read: async () => stored, write: async (value: ReplacedImages) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) };
    const run = () =>
      new ImageMaintenance({
        engine: engine.engine,
        registryTransport: fakeRegistry({ 'majikmate/devcontainer-dev': ['2'] }).transport,
        log: () => {},
        prefixes: () => PREFIXES,
        knownRepositories: async () => [],
        replaced,
      }).pass();
    // v1 is replaced by v2 and listed as <none> <none> (not in the list of the repository): two versions stay.
    dangling['sha256:v1'] = '2026-09-01T00:00:00Z';
    await run();
    // Review round 7 of PR #57: the store keeps every ID seen with a tag of the repository, so also the current v2.
    expect(Object.keys(stored)).toEqual([DEV]);
    expect([...stored[DEV]].sort()).toEqual(['sha256:v1', 'sha256:v2']);
    // Plan step 11I (U1, decision of 2026-10-08): the removals of the engine (`docker image rm` before), here and below.
    expect(removed(engine.calls)).toEqual([]);
    // The next update: v1 is now the third version and is removed by its ID.
    const second = fakeEngine({ images: [image(DEV, '2', 'sha256:v2', '2026-09-28')], pulled: { [`${DEV}:2`]: 'sha256:v3' }, dangling });
    dangling['sha256:v2'] = '2026-09-28T00:00:00Z';
    await new ImageMaintenance({
      engine: second.engine,
      registryTransport: fakeRegistry({ 'majikmate/devcontainer-dev': ['2'] }).transport,
      log: () => {},
      prefixes: () => PREFIXES,
      knownRepositories: async () => [],
      replaced,
    }).pass();
    expect(removed(second.calls)).toEqual([['removeImage', 'sha256:v1']]);
    expect(stored[DEV]).toContain('sha256:v2');
    expect(parseReplacedImages('{"ghcr.io/a/b":["sha256:x",3],"ubuntu":["sha256:y"]}')).toEqual({ 'ghcr.io/a/b': ['sha256:x'] });
    expect(parseReplacedImages('not json')).toEqual({});
  });

  // Review round 7 of PR #57: the update of the extension at each open (or a user) pulls `:<major>` before the monitor;
  // the image that it replaced was never known as replaced and stayed for ever.
  it('removes older versions also when another tool pulled the new ones', async () => {
    const dangling: Record<string, string> = {};
    let stored: ReplacedImages = {};
    const replaced = { read: async () => stored, write: async (value: ReplacedImages) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) };
    // Each pass sees `:2` on the image that another tool pulled since; the monitor's own pull changes nothing.
    const pass = async (current: string, created: string) => {
      const engine = fakeEngine({ images: [image(DEV, '2', current, created)], dangling });
      await new ImageMaintenance({
        engine: engine.engine,
        registryTransport: fakeRegistry({ 'majikmate/devcontainer-dev': ['2'] }).transport,
        log: () => {},
        prefixes: () => PREFIXES,
        knownRepositories: async () => [],
        replaced,
      }).pass();
      return engine;
    };
    await pass('sha256:v1', '2026-09-01');
    dangling['sha256:v1'] = '2026-09-01T00:00:00Z';
    await pass('sha256:v2', '2026-09-10');
    dangling['sha256:v2'] = '2026-09-10T00:00:00Z';
    const engine = await pass('sha256:v3', '2026-09-20');
    // Plan step 11I (U1, decision of 2026-10-08): changed expectation, the removal of the engine (was `docker image rm`).
    expect(removed(engine.calls)).toEqual([['removeImage', 'sha256:v1']]);
  });

  // Review round 8 of PR #57 (S1): an ID stored for two repositories was removed by one while the other kept it.
  it('removes no image that another repository keeps as one of its two newest versions', async () => {
    const MINE = 'ghcr.io/majikmate/devcontainer-dev-mine';
    const engine = fakeEngine({
      images: [image(DEV, '2', 'sha256:y', '2026-09-28'), image(MINE, '3', 'sha256:p', '2026-09-27'), image(MINE, '2', 'sha256:q', '2026-09-26')],
      dangling: { 'sha256:x': '2026-09-01T00:00:00Z' },
    });
    const stored: ReplacedImages = { [DEV]: ['sha256:x'], [MINE]: ['sha256:x'] };
    await new ImageMaintenance({
      engine: engine.engine,
      registryTransport: fakeRegistry({}).transport,
      log: () => {},
      prefixes: () => PREFIXES,
      knownRepositories: async () => [],
      replaced: { read: async () => stored, write: async () => {} },
    }).pass();
    // Plan step 11I (U1, decision of 2026-10-08): no removal of the engine (`docker image rm` before).
    expect(removed(engine.calls)).toEqual([]);
  });

  // Review round 8 of PR #57 (S2): beyond the limit, the IDs that are tagged now go first, not the untagged ones.
  // Review round 8 (S3): observe remembers the tagged IDs between the passes.
  it('keeps untagged IDs beyond the limit and remembers tagged IDs between passes', async () => {
    const tagged = Array.from({ length: 210 }, (_, index) => image(DEV, `2.0.${index}`, `sha256:t${index}`, '2026-09-01'));
    let stored: ReplacedImages = { [DEV]: ['sha256:old1', 'sha256:old2'] };
    const maintenance = new ImageMaintenance({
      engine: fakeEngine({ images: tagged }).engine,
      registryTransport: fakeRegistry({}).transport,
      log: () => {},
      prefixes: () => PREFIXES,
      knownRepositories: async () => [],
      replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
    });
    await maintenance.observe();
    expect(stored[DEV]).toHaveLength(200);
    expect(stored[DEV].slice(0, 2)).toEqual(['sha256:old1', 'sha256:old2']);
  });

  // Monitor cleanup, user decision 2026-09-29 (R3): the store drops empty lists. Review round 1 of PR #63 (B1): changed
  // expectation, the repositories of other prefixes are kept now (before: dropped); the prefixes change between the
  // computers of a shared engine.
  it('prunes the stored IDs: no empty lists, and keeps the repositories of other prefixes', () => {
    const OLD = 'ghcr.io/someone/else';
    const given: ReplacedImages = { [DEV]: ['sha256:a'], [WEB]: [], [OLD]: ['sha256:b'] };
    expect(pruneReplacedImages(given)).toEqual({ [DEV]: ['sha256:a'], [OLD]: ['sha256:b'] });
    // The given record is not changed.
    expect(given[WEB]).toEqual([]);
    expect(pruneReplacedImages({})).toEqual({});
  });

  it('writes the pruned store at the end of a pass', async () => {
    const OLD = 'ghcr.io/someone/else';
    let stored: ReplacedImages = { [DEV]: ['sha256:v1'], [WEB]: [], [OLD]: ['sha256:gone'] };
    await new ImageMaintenance({
      engine: fakeEngine({ images: [image(DEV, '2', 'sha256:v1', '2026-09-01')] }).engine,
      registryTransport: fakeRegistry({}).transport,
      log: () => {},
      prefixes: () => PREFIXES,
      knownRepositories: async () => [],
      replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
    }).pass();
    // Review round 1 of PR #63 (B1): changed expectation, the repository of another prefix stays in the store (before: it
    // was dropped); only the empty list goes.
    expect(stored).toEqual({ [DEV]: ['sha256:v1'], [OLD]: ['sha256:gone'] });
  });

  // Review round 1 of PR #57 (G): Docker removes the tag of an image that another image is built on and keeps the image.
  it('leaves an older image alone that another image is built on, and removes nothing when the layers cannot be read', async () => {
    const images = [
      image(DEV, '2.0.14', 'sha256:a', '2026-09-20'),
      image(DEV, '2.0.13', 'sha256:b', '2026-09-10'),
      image(DEV, '2.0.12', 'sha256:base', '2026-09-01'),
    ];
    const engine = fakeEngine({ images, layers: { 'sha256:base': ['l1', 'l2'], 'sha256:environment': ['l1', 'l2', 'l3'] } });
    const log: string[] = [];
    const run = (target: ImageEngine) =>
      new ImageMaintenance({ engine: target, registryTransport: fakeRegistry({}).transport, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    await run(engine.engine);
    // Plan step 11I (U1, decision of 2026-10-08): no removal of the engine (`docker image rm` before), here and below.
    expect(removed(engine.calls)).toEqual([]);
    expect(log).toContain(`The older image ${DEV} (2.0.12) stays: another image is built on it.`);
    const failing = fakeEngine({ images, failInspect: true });
    await run(failing.engine);
    expect(removed(failing.calls)).toEqual([]);
    expect(log).toContain(`The older image ${DEV} (2.0.12) stays: its layers could not be read.`);
    // Plan step 11I (U1): an engine whose inspect fails (it does not answer) removes nothing either.
    const broken: ImageEngine = { ...fakeEngine({ images }).engine, inspect: async () => Promise.reject(new EngineError('the daemon is busy', 500)) };
    const before = log.length;
    await run(broken);
    expect(log.slice(before)).toContain(`The older image ${DEV} (2.0.12) stays: its layers could not be read.`);
  });

  it('does not update a repository whose tags cannot be read, and still cleans it', async () => {
    const engine = fakeEngine({
      images: [image(DEV, '2.0.14', 'sha256:a', '2026-09-20'), image(DEV, '2.0.13', 'sha256:b', '2026-09-10'), image(DEV, '2.0.12', 'sha256:c', '2026-09-01')],
    });
    const log: string[] = [];
    const registryTransport = (): HttpTransport => ({ request: async () => ({ status: 500, headers: {}, body: '' }) });
    await new ImageMaintenance({ engine: engine.engine, registryTransport, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    expect(engine.calls.some((call) => call[0] === 'pull')).toBe(false);
    // Cleanup C5 (plan step 11J, C1): changed expectation, the reason as the worker's registry client gives it (was: `HTTP
    // 500`).
    expect(log[0]).toBe(`The tags of ${DEV} could not be read; it is not updated: The registry answered with HTTP 500.`);
    // Plan step 11I (U1, decision of 2026-10-08): changed expectation, the removal of the engine (was `docker image rm`).
    expect(removed(engine.calls)).toEqual([['removeImage', `${DEV}:2.0.12`]]);
  });

  // User request 2026-09-28 ("in a guided cron style manner"): the tests of the daily time (06:07 in Europe/Vienna,
  // daylight saving time) and of the time zone moved, with the same expectations, to src/core/remoteMonitor/cron.test.ts.

  it('does nothing without prefixes, and never throws when Docker does not answer', async () => {
    const calls: string[] = [];
    // Plan step 11I (U1, decision of 2026-10-08): changed fixture, an engine whose every call fails (a CLI that could not
    // connect before).
    const failing = (name: string) => async (): Promise<never> => {
      calls.push(name);
      throw new Error('connect ECONNREFUSED /var/run/docker.sock');
    };
    const engine: ImageEngine = { images: failing('images'), inspect: failing('inspect'), pull: failing('pull'), containerIds: failing('containerIds'), removeImage: failing('removeImage') };
    const registryTransport = (): HttpTransport => ({ request: async () => ({ status: 200, headers: {}, body: '{}' }) });
    await new ImageMaintenance({ engine, registryTransport, log: () => {}, prefixes: () => [], knownRepositories: async () => [] }).pass();
    expect(calls).toEqual([]);
    const log: string[] = [];
    await new ImageMaintenance({ engine, registryTransport, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    // Plan step 11I (U1): changed expectation, the failure of the list of the engine (was "docker image ls failed: Cannot
    // connect to the Docker daemon").
    expect(log).toEqual(['The images could not be maintained: the list of the images failed: connect ECONNREFUSED /var/run/docker.sock']);
    expect(calls).toEqual(['images']);
  });
});

// Plan step 11I (U1, decision of 2026-10-08): the image maintenance over the Engine API; the answers of the engine that the
// Docker CLI hid (an error in the stream of a pull, an image in use, a reference that is gone, an engine that does not
// answer), the time limit of each call, and the requests of the real port.
describe('the image maintenance over the Engine API (plan step 11I, U1)', () => {
  const VERSIONS = [image(DEV, '2', 'sha256:new', '2026-09-20'), image(DEV, '2.0.14', 'sha256:new', '2026-09-20'), image(DEV, '2.0.13', 'sha256:prev', '2026-09-10')];

  it('logs a pull whose stream reports an error, records no replaced image for it, and still cleans', async () => {
    const engine = fakeEngine({ images: [...VERSIONS, image(DEV, '2.0.12', 'sha256:old', '2026-09-01')], pulled: { [`${DEV}:2`]: 'sha256:newer' } });
    let stored: ReplacedImages = {};
    const log: string[] = [];
    await new ImageMaintenance({
      // The engine answers 200, and its stream carries the error (the port rejects with its message).
      engine: { ...engine.engine, pull: async (reference) => (engine.calls.push(['pull', reference]), Promise.reject(new EngineError('manifest unknown', 200))) },
      registryTransport: fakeRegistry({ 'majikmate/devcontainer-dev': ['2'] }).transport,
      log: (message) => log.push(message),
      prefixes: () => PREFIXES,
      knownRepositories: async () => [],
      replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
    }).pass();
    expect(log).toEqual([`${DEV}:2 could not be pulled: manifest unknown`, `Removed the older image ${DEV} (2.0.12).`]);
    // The pull did not move the reference: no ID is recorded as replaced by it (the store has the tagged IDs only).
    expect([...stored[DEV]].sort()).toEqual(['sha256:new', 'sha256:old', 'sha256:prev']);
    expect(removed(engine.calls)).toEqual([['removeImage', `${DEV}:2.0.12`]]);
  });

  it('tries every reference of a version; one in use (409) keeps it, and the log names the first refusal', async () => {
    const engine = fakeEngine({ images: [...VERSIONS, image(DEV, '1.0.0', 'sha256:old', '2026-08-01'), image(DEV, '1.0', 'sha256:old', '2026-08-01')], failRemove: [`${DEV}:1.0.0`] });
    const log: string[] = [];
    await new ImageMaintenance({ engine: engine.engine, registryTransport: fakeRegistry({}).transport, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    // As `docker image rm a b`: each reference in turn, also after a refusal.
    expect(removed(engine.calls)).toEqual([
      ['removeImage', `${DEV}:1.0.0`],
      ['removeImage', `${DEV}:1.0`],
    ]);
    expect(log).toContain(`The older image ${DEV} (1.0.0, 1.0) stays: ${DEV}:1.0.0 is in use (a container, or an image built on it); the engine answered 409.`);
    // The refusals of all of a version's references share one time limit.
    expect(engine.removals[0][1]).toBe(engine.removals[1][1]);
  });

  it('a reference that is gone (404) keeps the version in the log as "No such image", as the CLI said; another failure names its message', async () => {
    const engine = fakeEngine({ images: [...VERSIONS, image(DEV, '2.0.12', 'sha256:old', '2026-09-01')] });
    const log: string[] = [];
    const run = (target: ImageEngine) =>
      new ImageMaintenance({ engine: target, registryTransport: fakeRegistry({}).transport, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    await run({ ...engine.engine, removeImage: async () => 'missing' });
    // (The registry of this test lists no tags: each pass logs that first.)
    expect(log.filter((line) => line.startsWith('The older image'))).toEqual([`The older image ${DEV} (2.0.12) stays: No such image: ${DEV}:2.0.12`]);
    await run({ ...engine.engine, removeImage: async () => Promise.reject(new EngineError('the daemon is busy', 500)) });
    expect(log.at(-1)).toBe(`The older image ${DEV} (2.0.12) stays: the daemon is busy`);
    // A removal that does not answer within its time limit.
    await run({ ...engine.engine, removeImage: async () => Promise.reject(abortError()) });
    expect(log.at(-1)).toBe(`The older image ${DEV} (2.0.12) stays: Docker did not answer within 120 seconds.`);
  });

  // As a failed `docker image inspect` of a chunk of IDs before: the layers of one image that cannot be read (removed
  // meanwhile: 404; or the engine fails for it) keep every older version in that pass, as that image may be built on one.
  it('removes nothing in a pass in which the layers of one image cannot be read', async () => {
    const images = [image(DEV, '2.0.14', 'sha256:a', '2026-09-20'), image(DEV, '2.0.13', 'sha256:b', '2026-09-10'), image(DEV, '2.0.12', 'sha256:base', '2026-09-01')];
    const layers = { 'sha256:base': ['l1', 'l2'], 'sha256:environment': ['l1', 'l2', 'l3'] };
    for (const answer of [async () => undefined, async () => Promise.reject(new EngineError('the daemon is busy', 500))]) {
      const engine = fakeEngine({ images, layers });
      const log: string[] = [];
      const target: ImageEngine = { ...engine.engine, inspect: async (kind, reference, signal) => (reference === 'sha256:environment' ? answer() : engine.engine.inspect(kind, reference, signal)) };
      await new ImageMaintenance({ engine: target, registryTransport: fakeRegistry({}).transport, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
      expect(removed(engine.calls)).toEqual([]);
      expect(log).toContain(`The older image ${DEV} (2.0.12) stays: its layers could not be read.`);
    }
  });

  // As a failed `docker image inspect --format '{{json .RepoTags}}…'` before: a stored replaced ID whose inspect fails is
  // forgotten (not kept for a later pass), and nothing is removed by it.
  it('forgets a stored replaced ID whose inspect fails, as before, and removes nothing by it', async () => {
    const engine = fakeEngine({ images: VERSIONS, dangling: { 'sha256:x': '2026-09-01T00:00:00Z' } });
    let stored: ReplacedImages = { [DEV]: ['sha256:x'] };
    const target: ImageEngine = { ...engine.engine, inspect: async (kind, reference, signal) => (reference === 'sha256:x' ? Promise.reject(new Error('connect ECONNREFUSED /var/run/docker.sock')) : engine.engine.inspect(kind, reference, signal)) };
    await new ImageMaintenance({
      engine: target,
      registryTransport: fakeRegistry({}).transport,
      log: () => {},
      prefixes: () => PREFIXES,
      knownRepositories: async () => [],
      replaced: { read: async () => stored, write: async (value) => void (stored = JSON.parse(JSON.stringify(value)) as ReplacedImages) },
    }).pass();
    expect(removed(engine.calls)).toEqual([]);
    expect(stored[DEV]).not.toContain('sha256:x');
  });

  it('removes no version whose containers cannot be listed (the ancestor check fails), and logs nothing for it', async () => {
    const engine = fakeEngine({ images: [...VERSIONS, image(DEV, '2.0.12', 'sha256:old', '2026-09-01')], usedBy: {} });
    const log: string[] = [];
    await new ImageMaintenance({
      engine: { ...engine.engine, containerIds: async () => Promise.reject(new Error('connect ECONNREFUSED /var/run/docker.sock')) },
      registryTransport: fakeRegistry({}).transport,
      log: (message) => log.push(message),
      prefixes: () => PREFIXES,
      knownRepositories: async () => [],
    }).pass();
    expect(removed(engine.calls)).toEqual([]);
    // (The registry of this test lists no tags: the pass logs only that.)
    expect(log).toEqual([`The tags of ${DEV} could not be read; it is not updated: HTTP 404`]);
    // One used by a container (the ancestor check of the engine): kept too.
    const used = fakeEngine({ images: [...VERSIONS, image(DEV, '2.0.12', 'sha256:old', '2026-09-01')], usedBy: { 'sha256:old': 'c'.repeat(64) } });
    await new ImageMaintenance({ engine: used.engine, registryTransport: fakeRegistry({}).transport, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    expect(used.calls).toContainEqual(['containerIds', JSON.stringify({ ancestor: ['sha256:old'] })]);
    expect(removed(used.calls)).toEqual([]);
  });

  // Each call of the engine keeps the time limit of its CLI command, as an AbortSignal (AbortSignal.timeout, read here
  // through a spy): a list or an inspect IMAGE_LIST_TIMEOUT_MS, a pull IMAGE_PULL_TIMEOUT_MS, the removal of a version
  // IMAGE_REMOVE_TIMEOUT_MS.
  it('gives each call of the engine its time limit', async () => {
    const limits = new Map<AbortSignal, number>();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const signal = new AbortController().signal;
      limits.set(signal, ms);
      return signal;
    });
    try {
      const engine = fakeEngine({ images: [...VERSIONS, image(DEV, '2.0.12', 'sha256:old', '2026-09-01')], pulled: { [`${DEV}:2`]: 'sha256:newer' } });
      const timed: Array<[string, number | undefined]> = [];
      const limit = (signal: AbortSignal | undefined) => (signal === undefined ? undefined : limits.get(signal));
      const target: ImageEngine = {
        images: async (filters, signal) => (timed.push(['images', limit(signal)]), engine.engine.images(filters)),
        inspect: async (kind, reference, signal) => (timed.push(['inspect', limit(signal)]), engine.engine.inspect(kind, reference)),
        pull: async (reference, options) => (timed.push(['pull', limit(options?.signal)]), engine.engine.pull(reference)),
        containerIds: async (filters, signal) => (timed.push(['containerIds', limit(signal)]), engine.engine.containerIds(filters)),
        removeImage: async (reference, signal) => (timed.push(['removeImage', limit(signal)]), engine.engine.removeImage(reference)),
      };
      await new ImageMaintenance({ engine: target, registryTransport: fakeRegistry({ 'majikmate/devcontainer-dev': ['2'] }).transport, log: () => {}, prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
      const byCall = new Map<string, Set<number | undefined>>();
      for (const [call, ms] of timed) byCall.set(call, new Set([...(byCall.get(call) ?? []), ms]));
      expect(Object.fromEntries([...byCall].map(([call, values]) => [call, [...values]]))).toEqual({
        images: [IMAGE_LIST_TIMEOUT_MS],
        inspect: [IMAGE_LIST_TIMEOUT_MS],
        pull: [IMAGE_PULL_TIMEOUT_MS],
        containerIds: [IMAGE_LIST_TIMEOUT_MS],
        removeImage: [IMAGE_REMOVE_TIMEOUT_MS],
      });
      expect([IMAGE_LIST_TIMEOUT_MS, IMAGE_PULL_TIMEOUT_MS, IMAGE_REMOVE_TIMEOUT_MS]).toEqual([60_000, 3_600_000, 120_000]);
      expect(removed(engine.calls).length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  // The requests of the real port (src/helperChannel/engineClient.ts) over an Engine API in memory, with the answers as the
  // engine gives them: `Created` of the list in Unix seconds, `RepoTags` and `RepoDigests`, the inspect JSON, the pull
  // stream, and 409 for an image in use.
  it('runs a pass over the real port: the list as rows of `docker image ls -a`, the pull without a login, the ancestor list, and the removal without force', async () => {
    const requests: EngineRequest[] = [];
    const ok = (value: unknown, status = 200): EngineAnswer => ({ status, body: JSON.stringify(value), truncated: false });
    const seconds = (date: string) => Date.parse(date) / 1000;
    const listed = [
      { Id: 'sha256:new', RepoTags: [`${DEV}:2`, `${DEV}:2.0.14`], RepoDigests: [`${DEV}@sha256:${'a'.repeat(64)}`], Created: seconds('2026-09-20T00:00:00Z') },
      { Id: 'sha256:prev', RepoTags: [`${DEV}:2.0.13`], RepoDigests: [], Created: seconds('2026-09-10T00:00:00Z') },
      // An image that a pull replaced on the classic store: only a digest of the repository (a `<none>` row of it).
      { Id: 'sha256:old', RepoTags: [], RepoDigests: [`${DEV}@sha256:${'b'.repeat(64)}`], Created: seconds('2026-09-01T00:00:00Z') },
      { Id: 'sha256:used', RepoTags: [`${DEV}:2.0.11`], RepoDigests: [], Created: seconds('2026-08-01T00:00:00Z') },
      { Id: 'sha256:other', RepoTags: ['ghcr.io/someone/else:1'], RepoDigests: [], Created: seconds('2026-07-01T00:00:00Z') },
    ];
    const api: EngineApi = async (request) => {
      requests.push(request);
      const path = decodeURIComponent(request.path);
      if (request.method === 'GET' && path.startsWith('/images/json')) return ok(listed);
      if (request.method === 'GET' && path.startsWith('/images/')) {
        const id = path === `/images/${DEV}:2/json` ? 'sha256:new' : path.slice('/images/'.length, -'/json'.length);
        return ok({ Id: id, RepoTags: [], Created: '2026-01-01T00:00:00Z', RootFS: { Type: 'layers', Layers: [`${id}/layer`] } });
      }
      if (request.method === 'POST' && path.startsWith('/images/create')) {
        request.onChunk?.('{"status":"Status: Image is up to date for ghcr.io/majikmate/devcontainer-dev:2"}\n');
        return ok('');
      }
      if (request.method === 'GET' && path.startsWith('/containers/json')) return ok(path.includes('sha256:used') ? [{ Id: 'c'.repeat(64) }] : []);
      if (request.method === 'DELETE' && path.startsWith('/images/')) return path === '/images/sha256:old' ? ok({ message: 'conflict: unable to delete sha256:old (cannot be forced) - image has dependent child images' }, 409) : ok([]);
      return ok({ message: 'not routed' }, 500);
    };
    const engine = dockerEngine(api, async () => Promise.reject(new Error('no exec in this test')));
    const log: string[] = [];
    await new ImageMaintenance({ engine, registryTransport: fakeRegistry({ 'majikmate/devcontainer-dev': ['2'] }).transport, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    const paths = requests.map((request) => `${request.method} ${decodeURIComponent(request.path)}`);
    // The list without `all` (no intermediate images; none of a repository), with no filter. Review round 1 of PR #126
    // (F2): within the bound of a list of every image, not the 1 MiB of the other requests.
    expect(paths).toContain('GET /images/json?filters={}');
    expect(requests.filter((request) => request.path.startsWith('/images/json')).map((request) => request.maxCharacters)).toEqual([
      MAX_ENGINE_LIST_ANSWER_CHARACTERS,
      MAX_ENGINE_LIST_ANSWER_CHARACTERS,
      MAX_ENGINE_LIST_ANSWER_CHARACTERS,
    ]);
    // The pull of the major tag, anonymous: no header of a login.
    const pull = requests.find((request) => request.path.startsWith('/images/create'))!;
    expect(decodeURIComponent(pull.path)).toBe(`/images/create?fromImage=${DEV}:2`);
    expect(pull.headers).toEqual({});
    // The two newest versions stay; the older ones: the one a container uses stays (ancestor), the one the engine refuses
    // (409) stays, without force: DELETE without a query.
    expect(paths).toContain('GET /containers/json?all=true&filters={"ancestor":["sha256:used"]}');
    expect(paths.filter((entry) => entry.startsWith('DELETE'))).toEqual(['DELETE /images/sha256:old']);
    expect(log).toEqual([`The older image ${DEV} (sha256:old) stays: sha256:old is in use (a container, or an image built on it); the engine answered 409.`]);
  });
});
