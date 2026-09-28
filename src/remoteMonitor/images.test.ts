// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as http from 'http';
import { describe, expect, it } from 'vitest';
import {
  ImageMaintenance,
  highestMajorTag,
  httpGetWith,
  imagePrefixesOf,
  parseBearerChallenge,
  parseImageList,
  prefixesFromEnv,
  splitRepository,
  versionsOf,
  type HttpGet,
  type LocalImage,
} from './images';
import type { DockerResult } from './main';

const DEV = 'ghcr.io/majikmate/devcontainer-dev';
const WEB = 'ghcr.io/majikmate/devcontainer-classroom-web';
const PREFIXES = ['ghcr.io/majikmate/devcontainer-classroom', 'ghcr.io/majikmate/devcontainer-dev'];

function image(repository: string, tag: string, id: string, createdAt: string): string {
  return JSON.stringify({ Repository: repository, Tag: tag, ID: id, CreatedAt: createdAt });
}

/** A Docker CLI of the engine of the test: its images, the containers per image, and the calls. */
// Review round 1 of PR #57 (G): `layers` of an image ID (default: one layer of its own, no image built on another).
function fakeEngine(options: { images: string[]; usedBy?: Record<string, string>; failRemove?: string[]; layers?: Record<string, string[]>; failInspect?: boolean }) {
  const calls: string[][] = [];
  let images = [...options.images];
  const idOf = (line: string) => (JSON.parse(line) as { ID: string }).ID;
  const docker = async (args: readonly string[]): Promise<DockerResult> => {
    calls.push([...args]);
    if (args[0] === 'image' && args[1] === 'ls' && args[2] === '-a') return { code: 0, stdout: [...new Set(images.map(idOf)), ...Object.keys(options.layers ?? {})].join('\n'), stderr: '' };
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (options.failInspect) return { code: 1, stdout: '', stderr: 'Error: No such image' };
      return { code: 0, stdout: args.slice(4).map((id) => `${id} ${JSON.stringify(options.layers?.[id] ?? [`${id}/layer`])}`).join('\n'), stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'ls') return { code: 0, stdout: images.join('\n'), stderr: '' };
    if (args[0] === 'pull') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'ps') {
      const id = /ancestor=(.*)$/.exec(args[args.length - 1])?.[1] ?? '';
      return { code: 0, stdout: options.usedBy?.[id] ?? '', stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'rm') {
      const references = args.slice(2);
      if (references.some((reference) => options.failRemove?.includes(reference))) {
        return { code: 1, stdout: '', stderr: 'Error response from daemon: conflict: image has dependent child images' };
      }
      images = images.filter((line) => {
        const item = JSON.parse(line) as { Repository: string; Tag: string; ID: string };
        return !references.includes(`${item.Repository}:${item.Tag}`) && !references.includes(item.ID);
      });
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { docker, calls };
}

/** A registry that wants a token from its challenge, then lists `tags` per repository path. */
function fakeRegistry(tags: Record<string, string[]>) {
  const requests: Array<{ url: string; auth?: string }> = [];
  const httpGet: HttpGet = async (url, headers): ReturnType<HttpGet> => {
    requests.push({ url, auth: headers.authorization });
    if (url.startsWith('https://ghcr.io/token?')) return { status: 200, headers: {}, body: JSON.stringify({ token: 'anon-token' }) };
    const match = /^https:\/\/ghcr\.io\/v2\/(.+)\/tags\/list$/.exec(url);
    if (!match) return { status: 404, headers: {}, body: '' };
    if (headers.authorization !== 'Bearer anon-token') {
      return {
        status: 401,
        headers: { 'www-authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${match[1]}:pull"` },
        body: '',
      };
    }
    const list = tags[match[1]];
    return list ? { status: 200, headers: {}, body: JSON.stringify({ name: match[1], tags: list }) } : { status: 404, headers: {}, body: '' };
  };
  return { httpGet, requests };
}

describe('the images of the remote Session Monitor (user requests 2026-09-28)', () => {
  it('reads the prefixes of the setting: a trailing * dropped, invalid ones left out', () => {
    expect(imagePrefixesOf(['ghcr.io/majikmate/devcontainer-dev*', 'ghcr.io/majikmate/devcontainer-dev', 'no-registry*', 'GHCR.io/x*', 3])).toEqual([
      'ghcr.io/majikmate/devcontainer-dev',
    ]);
    expect(prefixesFromEnv({ DEVENV_IMAGE_PREFIXES: JSON.stringify(PREFIXES) })).toEqual(PREFIXES);
    expect(prefixesFromEnv({ DEVENV_IMAGE_PREFIXES: 'not json' })).toEqual([]);
    expect(prefixesFromEnv({})).toEqual([]);
    // Review round 5 of PR #57 (P1): at most 50, as the monitor takes with `settings -`.
    const many = Array.from({ length: 60 }, (_, index) => `ghcr.io/acme/image-${index}*`);
    expect(imagePrefixesOf(many)).toHaveLength(50);
    expect(prefixesFromEnv({ DEVENV_IMAGE_PREFIXES: JSON.stringify(many) })).toHaveLength(50);
  });

  it('takes the highest plain major tag (the registry has latest, 2, 2.0, 2.0.14, 2.0.14-amd64)', () => {
    expect(highestMajorTag(['latest', '2.0', '2', '2.0.14-amd64', '2.0.14', '1', '10'])).toBe('10');
    expect(highestMajorTag(['latest', '2.0.14'])).toBeUndefined();
    expect(highestMajorTag(['01', '2'])).toBe('2');
  });

  it('orders the versions of a repository newest first: version tags, then the creation time', () => {
    const images: LocalImage[] = parseImageList(
      [
        image(DEV, '2.0.13', 'sha256:b', '2026-09-01 10:00:00 +0000 UTC'),
        image(DEV, '2', 'sha256:c', '2026-09-20 10:00:00 +0000 UTC'),
        image(DEV, '2.0.14', 'sha256:c', '2026-09-20 10:00:00 +0000 UTC'),
        image(DEV, '1.9.0', 'sha256:a', '2026-10-01 10:00:00 +0000 UTC'),
        image(DEV, '<none>', 'sha256:d', '2026-09-25 10:00:00 +0000 UTC'),
        'not json',
      ].join('\n'),
    );
    expect(versionsOf(images).map((version) => [version.id, version.tags])).toEqual([
      ['sha256:c', ['2', '2.0.14']],
      ['sha256:b', ['2.0.13']],
      ['sha256:a', ['1.9.0']],
      ['sha256:d', []],
    ]);
  });

  it('splits a repository and reads a Bearer challenge', () => {
    expect(splitRepository(DEV)).toEqual({ registry: 'ghcr.io', path: 'majikmate/devcontainer-dev' });
    expect(splitRepository('library/ubuntu')).toBeUndefined();
    expect(parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"')).toEqual({
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
      scope: 'repository:a/b:pull',
    });
    // Only https realms.
    expect(parseBearerChallenge('Bearer realm="http://evil/token"')).toBeUndefined();
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined();
  });

  it('pulls the latest major version of each repository on the host and of the list of the extension (all images)', async () => {
    const engine = fakeEngine({
      images: [image(DEV, '2', 'sha256:c', '2026-09-20'), image('ghcr.io/other/base', '1', 'sha256:x', '2026-09-20')],
    });
    const registry = fakeRegistry({ 'majikmate/devcontainer-dev': ['latest', '2', '2.0.14'], 'majikmate/devcontainer-classroom-web': ['1', '2', '3'] });
    const log: string[] = [];
    await new ImageMaintenance({
      docker: engine.docker,
      httpGet: registry.httpGet,
      log: (message) => log.push(message),
      prefixes: () => PREFIXES,
      // A repository that the host has no image of yet, and one of no prefix (left out).
      knownRepositories: async () => [WEB, 'ghcr.io/other/base'],
    }).pass();
    expect(engine.calls.filter((call) => call[0] === 'pull')).toEqual([
      ['pull', '--quiet', `${DEV}:2`],
      ['pull', '--quiet', `${WEB}:3`],
    ]);
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
    await new ImageMaintenance({ docker: engine.docker, httpGet: registry.httpGet, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    const removals = engine.calls.filter((call) => call[0] === 'image' && call[1] === 'rm');
    expect(removals).toEqual([
      ['image', 'rm', `${DEV}:2.0.11`],
      ['image', 'rm', `${DEV}:2.0.10`],
      ['image', 'rm', 'sha256:dangling'],
    ]);
    expect(engine.calls.flat()).not.toContain('-f');
    expect(engine.calls.flat()).not.toContain('--force');
    expect(log).toEqual([
      `Removed the older image ${DEV} (2.0.11).`,
      `The older image ${DEV} (2.0.10) stays: Error response from daemon: conflict: image has dependent child images`,
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
    await new ImageMaintenance({ docker: engine.docker, httpGet: registry.httpGet, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    expect(engine.calls.filter((call) => call[0] === 'image' && call[1] === 'rm')).toEqual([
      ['image', 'rm', `${DEV}:2.0.13`],
      ['image', 'rm', `${WEB}:0.9.0`],
    ]);
    expect(versionsOf(parseImageList([image(DEV, '2.0', 'sha256:a', '1'), image(DEV, '2.0.14', 'sha256:b', '2'), image(DEV, '3.0.0', 'sha256:c', '0')].join('\n'))).map((version) => version.id)).toEqual([
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
      docker: engine.docker,
      httpGet: fakeRegistry({ 'majikmate/devcontainer-dev': ['2'] }).httpGet,
      log: (message) => log.push(message),
      prefixes: () => PREFIXES,
      knownRepositories: async () => [],
    }).pass();
    expect(engine.calls.filter((call) => call[0] === 'image' && call[1] === 'rm')).toEqual([['image', 'rm', 'sha256:older']]);
  });

  // Review round 2 of PR #57 (R5): the idle time limit of the socket alone let a registry that sends a byte now and then,
  // or a connection cut in the middle of an answer, keep a pass (and every later one) open for ever.
  it('the registry request ends within its time limit, also when the answer trickles or is cut', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/trickle') {
        response.writeHead(200, { 'content-length': '1000' });
        const timer = setInterval(() => response.write('x'), 50);
        response.on('close', () => clearInterval(timer));
      } else if (request.url === '/cut') {
        response.writeHead(200, { 'content-length': '1000' });
        response.write('xyz', () => setTimeout(() => request.socket.destroy(), 20));
      } else {
        response.end('{"tags":[]}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const get = http.get as unknown as Parameters<typeof httpGetWith>[0];
    try {
      const started = Date.now();
      await expect(httpGetWith(get, `${base}/trickle`, {}, 400)).rejects.toThrow('did not answer in time');
      expect(Date.now() - started).toBeLessThan(2_000);
      await expect(httpGetWith(get, `${base}/cut`, {}, 5_000)).rejects.toThrow();
      await expect(httpGetWith(get, `${base}/ok`, {}, 5_000)).resolves.toMatchObject({ status: 200, body: '{"tags":[]}' });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Review round 3 of PR #57 (N1): `get` throws at once for an invalid URL or header; the time limit then ended the
  // monitor with an uncaught error.
  it('a registry request that cannot start rejects and leaves no timer behind', async () => {
    const throwing = (() => {
      throw new TypeError('Invalid URL');
    }) as unknown as Parameters<typeof httpGetWith>[0];
    await expect(httpGetWith(throwing, 'https://[bad', {}, 50)).rejects.toThrow('Invalid URL');
    // Past the time limit: nothing is thrown (vitest fails on an uncaught error).
    await new Promise((resolve) => setTimeout(resolve, 120));
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
    const run = (docker: typeof engine.docker) =>
      new ImageMaintenance({ docker, httpGet: fakeRegistry({}).httpGet, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    await run(engine.docker);
    expect(engine.calls.some((call) => call[1] === 'rm')).toBe(false);
    expect(log).toContain(`The older image ${DEV} (2.0.12) stays: another image is built on it.`);
    const failing = fakeEngine({ images, failInspect: true });
    await run(failing.docker);
    expect(failing.calls.some((call) => call[1] === 'rm')).toBe(false);
    expect(log).toContain(`The older image ${DEV} (2.0.12) stays: its layers could not be read.`);
  });

  it('does not update a repository whose tags cannot be read, and still cleans it', async () => {
    const engine = fakeEngine({
      images: [image(DEV, '2.0.14', 'sha256:a', '2026-09-20'), image(DEV, '2.0.13', 'sha256:b', '2026-09-10'), image(DEV, '2.0.12', 'sha256:c', '2026-09-01')],
    });
    const log: string[] = [];
    const httpGet: HttpGet = async () => ({ status: 500, headers: {}, body: '' });
    await new ImageMaintenance({ docker: engine.docker, httpGet, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    expect(engine.calls.some((call) => call[0] === 'pull')).toBe(false);
    expect(log[0]).toBe(`The tags of ${DEV} could not be read; it is not updated: HTTP 500`);
    expect(engine.calls.filter((call) => call[1] === 'rm')).toEqual([['image', 'rm', `${DEV}:2.0.12`]]);
  });

  // User request 2026-09-28 ("in a guided cron style manner"): the tests of the daily time (06:07 in Europe/Vienna,
  // daylight saving time) and of the time zone moved, with the same expectations, to src/core/remoteMonitor/cron.test.ts.

  it('does nothing without prefixes, and never throws when Docker does not answer', async () => {
    const calls: string[][] = [];
    const docker = async (args: readonly string[]): Promise<DockerResult> => {
      calls.push([...args]);
      return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
    };
    const httpGet: HttpGet = async () => ({ status: 200, headers: {}, body: '{}' });
    await new ImageMaintenance({ docker, httpGet, log: () => {}, prefixes: () => [], knownRepositories: async () => [] }).pass();
    expect(calls).toEqual([]);
    const log: string[] = [];
    await new ImageMaintenance({ docker, httpGet, log: (message) => log.push(message), prefixes: () => PREFIXES, knownRepositories: async () => [] }).pass();
    expect(log).toEqual(['The images could not be maintained: docker image ls failed: Cannot connect to the Docker daemon']);
  });
});
